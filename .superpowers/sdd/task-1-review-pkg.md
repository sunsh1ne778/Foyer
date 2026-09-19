# Task 1 review package
Base: bb546cd584e42ba5bf8281e21b18af28620bb42a
Head: working tree (no commit, as instructed)

## git status --short (task paths)
A  .gitmodules A  third_party/juicefs

## git ls-files -s third_party/juicefs
160000 30190ca1094d26e85f19a979ca51b0ea19af1eaa 0	third_party/juicefs

## git submodule status
 30190ca1094d26e85f19a979ca51b0ea19af1eaa third_party/juicefs (v1.3.0)

## git -C third_party/juicefs describe --tags
v1.3.0

## .gitmodules
[submodule "third_party/juicefs"]
	path = third_party/juicefs
	url = https://github.com/juicedata/juicefs.git


## git diff -- .gitmodules

diff --git a/.gitmodules b/.gitmodules new file mode 100644 index 0000000..de02d25 --- /dev/null +++ b/.gitmodules @@ -0,0 +1,3 @@ +[submodule "third_party/juicefs"] +	path = third_party/juicefs +	url = https://github.com/juicedata/juicefs.git
