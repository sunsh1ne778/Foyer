//go:build !wireinject

package main

import "filestore/internal/app"

func initialize() (*app.Runtime, func(), error) {
	return app.Build()
}
