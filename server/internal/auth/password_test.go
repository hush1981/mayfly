package auth

import (
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("supersecret123")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	ok, err := VerifyPassword("supersecret123", hash)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("expected password to match")
	}
}

func TestWrongPassword(t *testing.T) {
	hash, _ := HashPassword("correctpassword")
	ok, err := VerifyPassword("wrongpassword", hash)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if ok {
		t.Fatal("expected password to not match")
	}
}

func TestDifferentSalts(t *testing.T) {
	h1, _ := HashPassword("password")
	h2, _ := HashPassword("password")
	if h1 == h2 {
		t.Fatal("expected different hashes due to different salts")
	}
}

func TestForeignHashParametersAreRefused(t *testing.T) {
	// A hash with other cost parameters must never be computed (memory / CPU bomb).
	for _, h := range []string{
		"$argon2id$v=19$m=4194304,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"$argon2id$v=19$m=65536,t=4000,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAA",
	} {
		if ok, err := VerifyPassword("x", h); ok || err == nil {
			t.Errorf("accepted %s", h)
		}
	}
}

func TestConcurrentHashingIsBounded(t *testing.T) {
	done := make(chan error, 12)
	for i := 0; i < 12; i++ {
		go func() {
			_, err := HashPassword("some password")
			done <- err
		}()
	}
	for i := 0; i < 12; i++ {
		if err := <-done; err != nil {
			t.Fatalf("hash %d: %v", i, err)
		}
	}
	if len(argonSlots) != 0 {
		t.Fatalf("slots not released: %d", len(argonSlots))
	}
}
