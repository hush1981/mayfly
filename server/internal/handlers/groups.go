package handlers

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	mw "github.com/hush1981/mayfly/server/internal/middleware"
	"github.com/hush1981/mayfly/server/internal/models"
	"github.com/hush1981/mayfly/server/internal/storage"
)

type GroupsHandler struct {
	pool        *pgxpool.Pool
	avatarStore storage.Storage
	mediaStore  storage.Storage
	quota       *MediaQuota
}

func NewGroupsHandler(pool *pgxpool.Pool, avatarStore, mediaStore storage.Storage, quota *MediaQuota) *GroupsHandler {
	return &GroupsHandler{pool: pool, avatarStore: avatarStore, mediaStore: mediaStore, quota: quota}
}

func validGroupName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, name != "" && utf8.RuneCountInString(name) <= 60
}

// groupFor loads the group and checks that the caller is an accepted member.
func (h *GroupsHandler) groupFor(c echo.Context) (*models.Group, string, error) {
	me, ok := mw.GetUserID(c)
	if !ok {
		return nil, "", echo.NewHTTPError(http.StatusUnauthorized)
	}
	groupID := c.Param("id")
	if _, err := uuid.Parse(groupID); err != nil {
		return nil, "", echo.NewHTTPError(http.StatusNotFound)
	}
	isMember, err := models.IsGroupMember(h.pool, groupID, me)
	if err != nil {
		return nil, "", echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !isMember {
		return nil, "", echo.NewHTTPError(http.StatusForbidden)
	}
	g, err := models.GetGroup(h.pool, groupID)
	if err != nil {
		return nil, "", echo.NewHTTPError(http.StatusNotFound)
	}
	// A broadcast list belongs to its owner alone.
	if g.Kind == models.GroupKindList && g.OwnerID != me {
		return nil, "", echo.NewHTTPError(http.StatusForbidden)
	}
	return g, me, nil
}

// mayEdit: in a group chat every member may change name and picture, in a broadcast list only the owner.
func mayEdit(g *models.Group, me string) bool {
	return g.Kind == models.GroupKindChat || g.OwnerID == me
}

func (h *GroupsHandler) Create(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	var body struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "name required")
	}
	name, ok := validGroupName(body.Name)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "group name must be 1-60 characters")
	}
	kind := body.Kind
	if kind == "" {
		kind = models.GroupKindList // clients up to 2.5 only know broadcast lists
	}
	if kind != models.GroupKindList && kind != models.GroupKindChat {
		return echo.NewHTTPError(http.StatusBadRequest, "kind must be 'list' or 'chat'")
	}
	group, err := models.CreateGroup(h.pool, name, currentUserID, kind)
	if errors.Is(err, models.ErrTooManyGroups) {
		return quotaError(http.StatusTooManyRequests, "quota", "you have too many groups and lists — delete one first")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not create group")
	}
	return c.JSON(http.StatusCreated, group)
}

func (h *GroupsHandler) List(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	groups, err := models.GetGroupsForUser(h.pool, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not list groups")
	}
	if groups == nil {
		groups = []models.Group{}
	}
	return c.JSON(http.StatusOK, groups)
}

func (h *GroupsHandler) ListMembers(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	groupID := c.Param("id")
	if _, err := uuid.Parse(groupID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	// Invited people may see who is in a chat before they decide; a list only shows to its owner.
	isMember, err := models.CanSeeGroup(h.pool, groupID, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !isMember {
		return echo.NewHTTPError(http.StatusForbidden)
	}
	members, err := models.GetGroupMembers(h.pool, groupID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not list members")
	}
	if members == nil {
		members = []models.GroupMember{}
	}
	return c.JSON(http.StatusOK, members)
}

// AddMember: broadcast list — the owner adds a friend directly. Group chat — any member
// invites one of their friends; the friend joins only after accepting (POST /groups/:id/join).
func (h *GroupsHandler) AddMember(c echo.Context) error {
	g, me, err := h.groupFor(c)
	if err != nil {
		return err
	}
	if g.Kind == models.GroupKindList && g.OwnerID != me {
		return echo.NewHTTPError(http.StatusForbidden)
	}
	var body struct {
		UserID string `json:"user_id"`
	}
	if err := c.Bind(&body); err != nil || body.UserID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "user_id required")
	}
	if _, err := uuid.Parse(body.UserID); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid user_id")
	}
	friends, err := models.AreFriends(h.pool, me, body.UserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !friends {
		return echo.NewHTTPError(http.StatusForbidden, "can only add friends to a group")
	}
	if blocked, err := models.IsBlockedEither(h.pool, me, body.UserID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	} else if blocked {
		return echo.NewHTTPError(http.StatusForbidden, "can only add friends to a group")
	}
	if g.Kind == models.GroupKindChat {
		invited, err := models.InviteToGroupChat(h.pool, g.ID, body.UserID, me)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "could not invite")
		}
		if !invited {
			return echo.NewHTTPError(http.StatusConflict, "already invited or member, or the group is full")
		}
		wakeUsers(h.pool, body.UserID)
		return c.NoContent(http.StatusNoContent)
	}
	if err := models.AddGroupMember(h.pool, g.ID, body.UserID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not add member")
	}
	return c.NoContent(http.StatusNoContent)
}

// Join accepts an invitation to a group chat.
func (h *GroupsHandler) Join(c echo.Context) error {
	me, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	groupID := c.Param("id")
	if _, err := uuid.Parse(groupID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	joined, err := models.AcceptGroupInvite(h.pool, groupID, me)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	if !joined {
		return echo.NewHTTPError(http.StatusNotFound, "no invitation")
	}
	return c.NoContent(http.StatusNoContent)
}

// Rename: every member of a group chat, only the owner of a broadcast list.
func (h *GroupsHandler) Rename(c echo.Context) error {
	g, me, err := h.groupFor(c)
	if err != nil {
		return err
	}
	if !mayEdit(g, me) {
		return echo.NewHTTPError(http.StatusForbidden)
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest)
	}
	name, ok := validGroupName(body.Name)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "group name must be 1-60 characters")
	}
	if err := models.RenameGroup(h.pool, g.ID, name); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *GroupsHandler) RemoveMember(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	groupID := c.Param("id")
	if _, err := uuid.Parse(groupID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	targetUserID := c.Param("uid")
	if _, err := uuid.Parse(targetUserID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	isOwner, err := models.IsGroupOwner(h.pool, groupID, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	// Owner can remove anyone; members can only remove themselves
	if !isOwner && currentUserID != targetUserID {
		return echo.NewHTTPError(http.StatusForbidden)
	}
	paths, err := models.RemoveGroupMember(h.pool, groupID, targetUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not remove member")
	}
	for _, p := range paths {
		_ = h.mediaStore.Delete(p)
	}
	if len(paths) > 0 || !groupExists(h.pool, groupID) {
		_ = h.avatarStore.Delete(groupID)
	}
	return c.NoContent(http.StatusNoContent)
}

// Delete removes a whole group (broadcast list); only its owner may do that.
func (h *GroupsHandler) Delete(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	groupID := c.Param("id")
	if _, err := uuid.Parse(groupID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	deleted, paths, err := models.DeleteGroup(h.pool, groupID, currentUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not delete group")
	}
	if !deleted {
		return echo.NewHTTPError(http.StatusForbidden)
	}
	for _, p := range paths {
		_ = h.mediaStore.Delete(p)
	}
	_ = h.avatarStore.Delete(groupID)
	return c.NoContent(http.StatusNoContent)
}

func (h *GroupsHandler) UploadAvatar(c echo.Context) error {
	g, me, err := h.groupFor(c)
	if err != nil {
		return err
	}
	if !mayEdit(g, me) {
		return echo.NewHTTPError(http.StatusForbidden, "only the owner can change the picture of a broadcast list")
	}
	groupID := g.ID

	if err := parseUpload(c); err != nil {
		return err
	}
	file, err := c.FormFile("avatar")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "avatar file required")
	}
	if file.Size > 5<<20 {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "avatar must be under 5 MB")
	}

	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError)
	}
	defer src.Close()
	if !isImage(src) {
		return echo.NewHTTPError(http.StatusUnsupportedMediaType, "avatar must be a JPEG or PNG image")
	}

	_ = h.avatarStore.Delete(groupID)
	if err := h.avatarStore.Save(groupID, src); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not store avatar")
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *GroupsHandler) ServeAvatar(c echo.Context) error {
	currentUserID, ok := mw.GetUserID(c)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized)
	}
	groupID := c.Param("id")
	if _, err := uuid.Parse(groupID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	// Only members (and people invited to a chat) see a group's picture; a list's only its owner.
	if member, err := models.CanSeeGroup(h.pool, groupID, currentUserID); err != nil || !member {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	f, err := h.avatarStore.Load(groupID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	defer f.Close()
	c.Response().Header().Set("Cache-Control", "private, max-age=300")
	return c.Stream(http.StatusOK, "image/jpeg", f)
}

func groupExists(pool *pgxpool.Pool, id string) bool {
	_, err := models.GetGroup(pool, id)
	return err == nil
}
