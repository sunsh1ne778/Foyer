//go:build wireinject

package main

import (
	"filestore/internal/app"

	"github.com/google/wire"
)

func initialize() (*app.Runtime, func(), error) {
	wire.Build(app.Build)
	return nil, nil, nil
}
