package foyer

import "testing"

func TestMapHostPathAnyDrive(t *testing.T) {
	cfg := Config{}
	got, err := MapHostPath(cfg, `D:\photos\raw`)
	if err != nil {
		t.Fatal(err)
	}
	if got != "/mnt/d/photos/raw" {
		t.Fatalf("got %s", got)
	}
	root, err := MapHostPath(cfg, `E:\`)
	if err != nil || root != "/mnt/e" {
		t.Fatalf("%s %v", root, err)
	}
}

func TestMapHostPathUnderHostData(t *testing.T) {
	cfg := Config{HostData: `E:\photos`, HostMount: "/host"}
	got, err := MapHostPath(cfg, `E:\photos\raw\a.jpg`)
	if err != nil {
		t.Fatal(err)
	}
	if got != "/mnt/e/photos/raw/a.jpg" {
		t.Fatalf("got %s", got)
	}
}

func TestMapHostPathAlreadyContainer(t *testing.T) {
	cfg := Config{}
	got, err := MapHostPath(cfg, "/mnt/e/raw")
	if err != nil || got != "/mnt/e/raw" {
		t.Fatalf("%s %v", got, err)
	}
}

func TestFileURI(t *testing.T) {
	if g := FileURI("/mnt/e/raw"); g != "file:///mnt/e/raw/" {
		t.Fatal(g)
	}
}
