package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"filestore/internal/config"
)

type Service struct {
	user   string
	pass   string
	secret []byte
}

func New(cfg *config.Config) *Service {
	return &Service{user: cfg.Auth.Username, pass: cfg.Auth.Password, secret: []byte(cfg.Auth.Secret)}
}

func (s *Service) Login(username, password string) (string, error) {
	if username != s.user || password != s.pass || s.pass == "" {
		return "", errors.New("invalid credentials")
	}
	if len(s.secret) == 0 {
		return "", errors.New("FILESTORE_SESSION_SECRET required")
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": username,
		"exp": time.Now().Add(24 * time.Hour).Unix(),
	})
	return tok.SignedString(s.secret)
}

func (s *Service) Parse(token string) (string, error) {
	t, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		return s.secret, nil
	})
	if err != nil || !t.Valid {
		return "", errors.New("invalid token")
	}
	claims, ok := t.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("invalid token")
	}
	sub, _ := claims["sub"].(string)
	return sub, nil
}

func (s *Service) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		user, err := s.Parse(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("user", user)
		c.Next()
	}
}
