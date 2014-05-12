
# Q-Git

Interface with a [JS-Git][] repository as a [Q-IO][] compatible file system.

[JS-Git]: https://github.com/creationix/js-git
[Q-IO]: https://github.com/kriskowal/q-io


## Usage

```sh
npm install --save js-git q-git git-node-fs
```

Create a repository. For example, this repository is backed by the `.git`
on your local file system.
JS-Git requires a certain amount of ceremony oweing to its many layers of
configurability and code reuse.

```js
var repo = {};
repo.rootPath = fs.join(__dirname, "..", ".git");
require("git-node-fs/mixins/fs-db")(repo, repo.rootPath);
require('js-git/mixins/create-tree')(repo);
require('js-git/mixins/pack-ops')(repo);
require('js-git/mixins/walkers')(repo);
require('js-git/mixins/read-combiner')(repo);
require('js-git/mixins/formats')(repo);
```

Then create a file system face for that repository for a particular reference,
or for an empty repository if no reference is given.

```js
var gitFs = new GitFs(repo, "refs/heads/master");
```

The Git file system supports a very close approximation of the interface the
[Q-IO][] file system.
Each change to the file system constructs a new tree, including streaming writes
to files.

## Copyright and License

Copyright (c) 2014, Montage Studio and contributors.

BSD 3-Clause License (enclosed).

