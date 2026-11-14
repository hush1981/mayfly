package storage

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Storage interface {
	Save(mediaID string, data io.Reader) error
	Load(mediaID string) (io.ReadCloser, error)
	Delete(mediaID string) error
}

type LocalStorage struct {
	baseDir string
}

func NewLocalStorage(baseDir string) (*LocalStorage, error) {
	if err := os.MkdirAll(baseDir, 0700); err != nil {
		return nil, fmt.Errorf("create storage dir: %w", err)
	}
	return &LocalStorage{baseDir: baseDir}, nil
}

func (s *LocalStorage) path(mediaID string) (string, error) {
	if !uuidRegex.MatchString(mediaID) {
		return "", errors.New("invalid media id")
	}
	p := filepath.Join(s.baseDir, mediaID)
	// path traversal guard
	if !filepath.IsAbs(p) || len(p) <= len(s.baseDir) {
		return "", errors.New("path traversal detected")
	}
	return p, nil
}

func (s *LocalStorage) Save(mediaID string, data io.Reader) error {
	p, err := s.path(mediaID)
	if err != nil {
		return err
	}
	// An upload that already sits in a temp file on the same disk is linked into place
	// instead of being copied (no second copy, no extra disk space). Link never replaces an
	// existing file, like O_EXCL below; on any error the copy path is used.
	if src, ok := data.(*os.File); ok {
		if st, err := src.Stat(); err == nil && st.Mode().IsRegular() {
			if err := os.Link(src.Name(), p); err == nil {
				if err := os.Chmod(p, 0600); err != nil {
					os.Remove(p)
					return fmt.Errorf("chmod file: %w", err)
				}
				return nil
			}
			if _, err := src.Seek(0, io.SeekStart); err != nil {
				return fmt.Errorf("rewind upload: %w", err)
			}
		}
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	defer f.Close()
	if _, err := io.Copy(f, data); err != nil {
		os.Remove(p)
		return fmt.Errorf("write file: %w", err)
	}
	return nil
}

func (s *LocalStorage) Load(mediaID string) (io.ReadCloser, error) {
	p, err := s.path(mediaID)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, fmt.Errorf("open file: %w", err)
	}
	return f, nil
}

func (s *LocalStorage) Delete(mediaID string) error {
	p, err := s.path(mediaID)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete file: %w", err)
	}
	return nil
}

// FreeBytes reports the free space available to the storage directory.
func (s *LocalStorage) FreeBytes() (uint64, error) {
	return freeBytes(s.baseDir)
}
