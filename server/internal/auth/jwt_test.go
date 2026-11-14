package auth

import (
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestTokenRoundTrip(t *testing.T) {
	os.Setenv("JWT_SECRET", "test_secret_at_least_32_bytes_long!")

	token, err := GenerateToken("user-123", 0)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	claims, err := ParseToken(token)
	if err != nil {
		t.Fatalf("ParseToken: %v", err)
	}
	if claims.UserID != "user-123" {
		t.Fatalf("expected user-123, got %s", claims.UserID)
	}
}

func TestExpiredToken(t *testing.T) {
	os.Setenv("JWT_SECRET", "test_secret_at_least_32_bytes_long!")

	claims := Claims{
		UserID: "user-123",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, _ := token.SignedString([]byte("test_secret_at_least_32_bytes_long!"))

	_, err := ParseToken(signed)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}

func TestWrongSecret(t *testing.T) {
	os.Setenv("JWT_SECRET", "correct_secret_32_bytes_long_here!")

	claims := Claims{
		UserID: "user-123",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, _ := token.SignedString([]byte("wrong_secret_32_bytes_long_here!!"))

	_, err := ParseToken(signed)
	if err == nil {
		t.Fatal("expected error for wrong secret")
	}
}
