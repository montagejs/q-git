"use strict";

// TODO Limit cyclic symbolic link walks.
// TODO GitFs.from(fs, path), Tree.from.
// TODO Cross-test error messages and codes against other file system
// implementations.
// TODO Enforce ccess control.

var Q = require("q");
require("q-io/fs"); // To resolve the cycle
var FsCommon = require("q-io/fs-common");
var Repository = require("./repository");

var MASK = parseInt("060000", 8);
var DIRECTORY = parseInt("040000", 8);
var SYMBOLIC_LINK = parseInt("020000", 8);
var FILE = 0;

var NEW_MASK = parseInt("000777", 8);
var NEW_DIRECTORY = parseInt("140755", 8);
var NEW_SYMBOLIC_LINK = parseInt("120644", 8);
var NEW_FILE = parseInt("100644", 8);

module.exports = GitFs;
function GitFs(repository, ref) {
    var self = this;
    function workingDirectory() {
        return self.workingDirectory;
    }
    FsCommon.update(this, workingDirectory);
    delete this.removeTree; // Use the override
    this.repository = Repository.from(repository);
    this.ref = ref;
    var hash;
    if (ref) {
        hash = this._getCommitHashForRef(ref);
    } else {
        hash = this.repository.saveAs("tree", {});
    }
    this.tree = hash.then(function (hash) {
        return self._makeRoot(hash);
    });
}

GitFs.prototype.workingDirectory = "/";

// Public interface

GitFs.prototype.open = function (path, flags, charset, options) {
    var self = this;

    if (typeof flags == "object") {
        options = flags;
        flags = options.flags;
        charset = options.charset;
    } else {
        options = options || {};
    }

    flags = flags || "r";
    var binary = flags.indexOf("b") >= 0;
    var write = flags.indexOf("w") >= 0;
    var append = flags.indexOf("a") >= 0;
    if (!binary) {
        charset = charset || "utf-8";
    }
    var mode = options.mode;

    if (write) {
        return new Writer(this, path, new Buffer([]), mode, charset);
    } else if (append) {
        return this._read(path).then(function (content) {
            return new Writer(self, path, content, mode, charset);
        });
    } else { // read
        return this._read(path).then(function (content) {
            if ("begin" in options && "end" in options) {
                return new Reader(
                    content.slice(options.begin, options.end),
                    charset
                );
            } else {
                return new Reader(content, charset);
            }
        });
    }
};

GitFs.prototype.remove = function (path) {
    var self = this;
    var directory = this.directory(path);
    var name = this.base(path);
    return self._transact(function (root) {
        return self._walkBack(root, directory, function (directory) {
            var entry = directory.entriesByName[name];
            if (!entry) {
                var error = new Error("Can't find " + JSON.stringify(name) + " in " + JSON.stringify(directory.path));
                error.code = "ENOENT";
                throw error;
            }
            if (!entry.isFile()) {
                var error = new Error("Can't remove non-file " + JSON.stringify(name) + " in " + JSON.stringify(directory.path));
                // TODO check code
                error.code = "EINVAL";
                throw error;
            }
            delete directory.entriesByName[name];
        })
        .catch(function (cause) {
            var error = new Error("Can't remove " + JSON.stringify(path) + " because " + cause.message);
            error.code = cause.code;
            throw error;
        })
    });
};

GitFs.prototype.removeDirectory = function (path) {
    var self = this;
    var directory = this.directory(path);
    var name = this.base(path);
    return self._transact(function (root) {
        return self._walkBack(root, directory, function (directory) {
            var entry = directory.entriesByName[name];
            var path = self.join(directory.path, name);
            if (!entry) {
                var error = new Error(
                    "Can't remove non-existant directory " +
                    JSON.stringify(path)
                );
                error.code = "ENOENT";
                throw error;
            }
            if (!entry.isDirectory()) {
                var error = new Error(
                    "Can't remove non-directory " +
                    JSON.stringify(path)
                );
                error.code = "ENOTDIR";
                throw error;
            }
            return directory._getTree(name).then(function (content) {
                if (content.entries.length) {
                    var error = new Error(
                        "Can't remove non-empty directory " +
                        JSON.stringify(path)
                    );
                    error.code = "ENOTEMPTY";
                    throw error;
                }
                delete directory.entriesByName[name];
            });
        });
    });
};

GitFs.prototype.removeTree = function (path) {
    var self = this;
    var directory = this.directory(path);
    var name = this.base(path);
    return self._transact(function (root) {
        return self._walkBack(root, directory, function (directory) {
            delete directory.entriesByName[name];
        });
    });
};

GitFs.prototype.rename = function (source, target) {
    // TODO make transactional
    return this.copy(source, target)
    .then(function () {
        return this.remove(source);
    });
};

GitFs.prototype.makeDirectory = function (path, mode) {
    // TODO check for existing file
    if (mode === undefined) {
        mode = NEW_DIRECTORY;
    }
    var self = this;
    var directory = this.directory(path);
    var base = this.base(path);
    return self._transact(function (root) {
        return self.repository.saveAs("tree", {})
        .then(function (hash) {
            return self._walkBack(root, directory, function (directory) {
                directory.entriesByName[base] = new Entry({
                    name: base,
                    hash: hash,
                    mode: (mode & NEW_MASK) | (NEW_DIRECTORY & ~NEW_MASK)
                });
            });
        });
    });
};

GitFs.prototype.list = function (path) {
    return this._walk(path)
    .invoke("_list")
    .catch(function (cause) {
        if (cause.code !== "ENOTDIR") {
            var error = new Error("Can't list " + JSON.stringify(path) + " because " + cause.message);
            error.code = cause.code;
            throw error;
        } else {
            throw cause;
        }
    });
};

GitFs.prototype.stat = function (path) {
    return this._walk(path).invoke("_follow");
};

GitFs.prototype.statLink = function (path) {
    return this._walk(path);
};

GitFs.prototype.link = function (source, target) {
    throw new Error("Can't create a hard link because Git does not support the concept");
};

GitFs.prototype.symbolicLink = function (target, relative, type) {
    // TODO test
    var self = this;
    var directory = this.directory(path);
    var base = this.base(path);
    return self._transact(function (root) {
        return self.repository.saveAs("blob", new Buffer(relative, "utf-8"))
        .then(function (hash) {
            return self._walkBack(root, directory, function (directory) {
                directory.entriesByName[base] = new Entry({
                    name: base,
                    hash: hash,
                    mode: modes.sym
                });
            });
        });
    });
};

GitFs.prototype.chown = function (path, uid, gid) {
    // TODO decide whether to duck-implement chown or just ignore
    return Q();
};

GitFs.prototype.chmod = function (path, mode) {
    // TODO type check on the file entry
    // TODO test
    var self = this;
    var directory = this.directory(path);
    var base = this.base(path);
    return self._transact(function (root) {
        return self._walkBack(root, directory, function (directory) {
            var oldMode = directory.entriesByName[base].mode;
            mode = (oldMode & MASK) | (mode & ~MASK);
            directory.entriesByName[base].mode = mode;
        });
    });
};

GitFs.prototype.canonical = function (path) {
    var self = this;
    return self._walk(path, function (node, parts, index) {
        return node._follow().then(function (node) {
            if (index !== parts.length) {
                return self.join(node.path, self.join(parts.slice(index)));
            } else {
                return node.path;
            }
        });
    });
};

GitFs.prototype.readLink = function (path) {
    return this._walk(path)
    .then(function (node) {
        if (!node.isSymbolicLink()) {
            var error = new Error("Can't read non-symbolic-link at " + JSON.stringify(path));
            error.code = "EINVAL";
            throw error;
        } else {
            return node._readLink();
        }
    })
};

// Implementation details particular to Git

GitFs.prototype._getCommitHashForRef = function (ref) {
    var self = this;
    return Q()
    .then(function () {
        return self.repository.readRef(ref);
    })
    .then(function (hash) {
        return self.repository.loadAs("commit", hash);
    })
    .then(function (commit) {
        return commit.tree;
    });
};

GitFs.prototype._makeRoot = function (hash) {
    var self = this;
    return new Tree(
        self,
        "",
        "/",
        {
            name: "",
            mode: NEW_DIRECTORY,
            hash: hash
        }
    )._load();
};

GitFs.prototype._walk = function (path, callback) {
    callback = callback || stopWalk;
    path = this.absolute(path);
    var self = this;
    var parts = this.split(path);
    // Ignore the "" in parts[0] (no drives on this file system)
    return this.tree.invoke("_walk", parts, 1, callback);
};

GitFs.prototype._walkBack = function (root, path, callback) {
    var self = this;
    // Get canonical path from current root
    // Can't use this.canonical because of data-lock on the new this.tree
    var parts = this.split(this.absolute(path));
    return root.invoke("_walk", parts, 1, stopWalk)
    .invoke("_follow")
    .then(function (node) {
        var parts = self.split(node.path);
        // Ignore the "" in parts[0] (no drives on this file system)
        return root.invoke("_walkBack", parts, 1, callback);
    });
};

function stopWalk(node, parts, index) {
    if (index !== parts.length) {
        var error = new Error(
            "Can't find " + JSON.stringify(parts[index]) +
            " in " + JSON.stringify(node.path)
        );
        error.code = "ENOENT";
        throw error;
    } else {
        return node;
    }
}

GitFs.prototype._read = function (path) {
    return this.stat(path).invoke("_read")
    .catch(function (error) {
        throw error;
        throw new Error("Can't read " + JSON.stringify(path) + " because " + error.message);
    });
};

GitFs.prototype._write = function (path, content, mode) {
    var self = this;
    var directory = this.directory(path);
    var base = this.base(path);
    mode = mode || NEW_FILE;
    return self._transact(function (root) {
        return self.repository.saveAs("blob", content)
        .then(function (hash) {
            return self._walkBack(root, directory, function (directory) {
                directory.entriesByName[base] = {
                    name: base,
                    hash: hash,
                    mode: (mode & NEW_MASK) | (NEW_FILE & ~NEW_MASK)
                };
            });
        });
    });
};

GitFs.prototype._transact = function (callback, thisp) {
    var self = this;
    var oldTree = this.tree;
    this.oldTree = this.tree;
    var newTree = callback(oldTree).then(function (hash) {
        return self._makeRoot(hash);
    });
    this.tree = newTree.catch(function () {
        // If the operation fails, the resulting promise will be an error, but
        // the original tree will be restored so future operations are not
        // corrupted.
        // This makes the system transactional.
        return oldTree;
    });
    return newTree.then(function () {
    });
};

function Node(fs, name, path, entry) {
    Object.defineProperty(this, "fs", {
        value: fs
    });
    this.path = path;
    this.name = entry.name;
    this.mode = entry.mode;
    this.hash = entry.hash;
}

Node.prototype._load = function () {
    return Q(this);
};

Node.prototype._walk = function (parts, index, callback) {
    var name = parts[index];
    if (name === "") {
        return this._walk(parts, index + 1, callback);
    } else {
        return callback(this, parts, index);
    }
};

Node.prototype._follow = function () {
    return Q(this);
};

Node.prototype._list = function () {
    var error = new Error(
        "Can't list non-directory " + JSON.stringify(this.path)
    );
    error.code = "ENOTDIR";
    throw error;
};

Node.prototype._read = function () {
    return this.fs.repository.loadAs("blob", this.hash);
};

Node.prototype.lastModified = function () {
    return null;
};

Node.prototype.lastAccessed = function () {
    return null;
};

Node.prototype.isDirectory = function () {
    return (this.mode & MASK) === DIRECTORY;
};

Node.prototype.isFile = function () {
    return (this.mode & MASK) === FILE;
};

Node.prototype.isBlockDevice = function () {
    return false;
};

Node.prototype.isCharacterDevice = function () {
    return false;
};

Node.prototype.isSymbolicLink = function () {
    return (this.mode & MASK) === SYMBOLIC_LINK;
};

Node.prototype.isFIFO = function () {
    return false;
};

Node.prototype.isSocket = function () {
    return false;
};

function Link(fs, path, mode, hash) {
    Node.apply(this, arguments);
}

Link.prototype = Object.create(Node.prototype);
Link.prototype.constructor = Link;

Link.prototype._walk = function (parts, index, callback) {
    var name = parts[index];
    if (name === "") {
        return this._walk(parts, index + 1, callback);
    } else if (parts.length === index) {
        return callback(this, parts, index);
    } else {
        return this._follow().invoke("_walk", parts, index, callback);
    }
};

Link.prototype._follow = function () {
    var self = this;
    return this._readLink()
    .then(function (relativePath) {
        var path = self.fs.normal(self.fs.directory(self.path), relativePath);
        return self.fs._walk(path).invoke("_follow");
    });
};

Link.prototype._readLink = function () {
    return this._read().invoke("toString", "utf-8");
};

function Tree(fs, name, path, entry) {
    Node.apply(this, arguments);
}

Tree.prototype = Object.create(Node.prototype);

Tree.prototype.constructor = Tree;

Tree.prototype._load = function () {
    var self = this;
    return self.fs.repository.loadAs("array", self.hash)
    .then(function (entries) {
        self.entries = entries;
        self.entriesByName = {};
        entries.forEach(function (entry) {
            self.entriesByName[entry.name] = new Entry(entry);
        });
        return self;
    });
};

Tree.prototype._list = function () {
    return this.entries.map(function (entry) {
        return entry.name;
    })
};

Tree.prototype._get = function (name) {
    var entry;
    if (!this.entriesByName[name]) {
        var error = new Error("Can't find " + JSON.stringify(name) + " in " + this.path);
        error.code = "ENOTDIR";
        throw error;
    }
    var entry = this.entriesByName[name];
    var constructor;
    if (entry.isDirectory()) {
        constructor = Tree;
    } else if (entry.isSymbolicLink()) {
        constructor = Link;
    } else {
        constructor = Node;
    }
    return new constructor(
        this.fs,
        name,
        this.fs.join(this.path, name),
        entry
    )._load();
};

Tree.prototype._getTree = function (name) {
    var entry = this.entriesByName[name];
    if (!entry) {
        var error = new Error("Can't find " + JSON.stringify(name) + " in " + this.path);
        error.code = "ENOENT";
        throw error;
    } else if (!entry.isDirectory()) {
        var error = new Error("Can't open non-directory " + JSON.stringify(name) + " in " + this.path);
        error.code = "ENOTDIR";
        throw error;
    }
    return new Tree(
        this.fs,
        name,
        this.fs.join(this.path, name),
        entry
    )._load();
};

Tree.prototype._walk = function (parts, index, callback) {
    if (index === parts.length) {
        return callback(this, parts, index);
    } else if (parts[index] === "") {
        return this._walk(parts, index + 1, callback);
    } else if (this.entriesByName[parts[index]]) {
        return this._get(parts[index]).invoke("_walk", parts, index + 1, callback);
    } else {
        return callback(this, parts, index);
    }
};

Tree.prototype._walkBack = function (parts, index, callback) {
    var self = this;
    var name = parts[index];
    var repository = this.fs.repository;
    var entriesByName = this.entriesByName;
    if (name === "") {
        return this._walkBack(parts, index + 1, callback);
    } else if (index === parts.length) {
        return Q().then(function () {
            return callback(self);
        }).then(function () {
            return repository.saveAs("tree", entriesByName)
        });
    } else {
        return this._getTree(name)
        .invoke("_walkBack", parts, index + 1, callback)
        .then(function (hash) {
            entriesByName[name].hash = hash;
            return repository.saveAs("tree", entriesByName);
        });
    }
};

function Entry(entry) {
    this.name = entry.name;
    this.mode = entry.mode;
    this.hash = entry.hash;
}

Entry.prototype = Object.create(Node.prototype);

function Writer(fs, path, content, mode, charset) {
    this._fs = fs;
    this._path = path;
    this._mode = mode;
    this._charset = charset;
    this._content = content || new Buffer();
}

Writer.prototype.write = function (chunk) {
    if (this._charset) {
        chunk = new Buffer(chunk, this._charset);
    }
    this._content = Buffer.concat([this._content, chunk]);
    return this._fs._write(this._path, this._content, this._mode);
};

Writer.prototype.close = function () {
    return Q();
};

function Reader(content, charset) {
    if (charset) {
        content = content.toString(charset);
    }
    this._content = content;
}

Reader.prototype.forEach = function (write, thisp) {
    var self = this;
    var content = this._content;
    return Q().then(function () {
        return write.call(thisp, content, 0, self);
    });
};

Reader.prototype.read = function () {
    return Q(this._content);
};

Reader.prototype.close = function () {
    return Q();
};

