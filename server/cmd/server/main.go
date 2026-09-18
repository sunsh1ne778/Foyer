package main

import (
	"log"
)

func main() {
	rt, cleanup, err := initialize()
	if err != nil {
		log.Fatal(err)
	}
	defer cleanup()
	if err := rt.Serve(); err != nil {
		log.Fatal(err)
	}
}
