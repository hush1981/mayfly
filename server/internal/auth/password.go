package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// MaxPasswordLen bounds Argon2 input so huge bodies cannot be used to burn CPU.
const MaxPasswordLen = 256

const (
	argonMemory      = 64 * 1024
	argonIterations  = 3
	argonParallelism = 4
	argonSaltLen     = 16
	argonKeyLen      = 32
)

// ErrBusy: too many password checks are running; the caller should answer 503.
var ErrBusy = errors.New("too many password operations in progress")

// Every Argon2id run needs 64 MB. Without a cap, a burst of logins from a few addresses
// would exhaust the memory of a small server, so only a few run at once and the rest wait
// (briefly) for a free slot.
const (
	argonConcurrency = 3
	argonWait        = 12 * time.Second
)

var argonSlots = make(chan struct{}, argonConcurrency)

func acquireArgon() error {
	select {
	case argonSlots <- struct{}{}:
		return nil
	default:
	}
	t := time.NewTimer(argonWait)
	defer t.Stop()
	select {
	case argonSlots <- struct{}{}:
		return nil
	case <-t.C:
		return ErrBusy
	}
}

func releaseArgon() { <-argonSlots }

// dummyHash is used when a username doesn't exist to prevent timing attacks.
var dummyHash = "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	if err := acquireArgon(); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLen)
	releaseArgon()

	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	), nil
}

func VerifyPassword(password, encodedHash string) (bool, error) {
	parts := strings.Split(encodedHash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("invalid hash format")
	}

	var m, t uint32
	var p uint8
	_, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p)
	if err != nil {
		return false, fmt.Errorf("parse params: %w", err)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("decode salt: %w", err)
	}

	storedKey, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("decode key: %w", err)
	}

	// Never run with parameters other than our own: a stored hash is the only source of
	// them, and absurd values there must not turn into a memory or CPU bomb.
	if m != argonMemory || t != argonIterations || p != argonParallelism || len(salt) != argonSaltLen || len(storedKey) != argonKeyLen {
		return false, errors.New("unsupported hash parameters")
	}
	if err := acquireArgon(); err != nil {
		return false, err
	}
	computedKey := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(storedKey)))
	releaseArgon()
	return subtle.ConstantTimeCompare(storedKey, computedKey) == 1, nil
}

// VerifyDummy runs argon2 against a dummy hash to prevent timing-based username enumeration.
func VerifyDummy(password string) {
	VerifyPassword(password, dummyHash) //nolint:errcheck
}
