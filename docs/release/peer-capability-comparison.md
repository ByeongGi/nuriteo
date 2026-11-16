# Peer terminal comparison

This note records the one terminal capability selected from StackBlitz, GitHub Codespaces, and CodeSandbox. The capability is shell command lists, `;`. Before this change, `shellGrammar.unsupported` included `command lists`. `shellGrammar.commandLists.status` is now `supported`. The OR operator stays supported.

## What the peers document

StackBlitz documents the WebContainers terminal as a normal command workflow. The [IDE screen guide](https://developer.stackblitz.com/guides/user-guide/ide-whats-on-your-screen) says: "The Terminal allows you to run commands, such as `ls`, `mkdir`, `npm start`, `node index.js`, and others – the same way you would on your local machine."

GitHub Codespaces documents a bash session in the browser editor. [Changing the shell in a codespace](https://docs.github.com/en/codespaces/customizing-your-codespace/changing-the-shell-in-a-codespace) says: "Codespaces that use the default dev container image come with the `bash`, `zsh`, and `fish` shells installed. If you open a new codespace in the VS Code web client, or connect to a codespace over SSH, the terminal opens with a `bash` session running by default."

CodeSandbox documents the same local-terminal workflow, including bash. The [repository terminal guide](https://codesandbox.io/docs/learn/repositories/terminal) says: "Terminals run inside CodeSandbox VMs and behave like your local terminals, accepting any commands you are used to running, such as git operations, bash scripts, package-management commands, and start servers." The [Terminals API](https://codesandbox.io/docs/sdk/terminals) creates that shell with the comment "Create a new terminal (bash is default)".

Bash defines the list operators those bash sessions already run. The [Bash reference for lists](https://www.gnu.org/software/bash/manual/html_node/Lists.html) says: "Commands separated by a ';' are executed sequentially; the shell waits for each command to terminate in turn. The return status is the exit status of the last command executed." It also says: "An OR list has the form command1 || command2. command2 is executed if, and only if, command1 returns a non-zero exit status." The return status of an AND or OR list is the exit status of the last command executed in the list. `&&` and `||` have equal precedence and associate to the left. `;` separates those lists.

## What this repository already records

Before this change, `compat/terminal-process-control.json` listed quoted argv, a pipeline, the AND operator, the OR operator, and stdout overwrite in `shellGrammar.supported`. `shellGrammar.unsupported` included background jobs, command substitution, command lists, heredoc, append redirect, stdin redirect, and shell blocks. After this change, `command lists` is in `shellGrammar.supported`, and `shellGrammar.commandLists.status` is `supported`. The other unsupported entries stay unsupported. The diagnostic code remains `ERR_NURITEO_UNSUPPORTED_SHELL_SYNTAX`.

Before this change, `packages/node-runtime/test/process/shell.test.ts` drove `createShellRuntime().run("echo ok; echo injected")` and expected `ShellSyntaxError`. That test now runs `echo one; echo two` and `false; echo after`. It still rejects background jobs, append redirect, stdin redirect, and command substitution. The preview terminal reaches the same parser through `createPreviewShellSession().run()`, which calls `createTerminalSession().run()`. The shipped check is `packages/workspace-runtime/test/terminal-session-control.test.ts`.

The whole terminal contract stays `partial`. Host kernel PTY, background job control, and command substitution stay unsupported. `README.ko.md` and `docs/release/known-limitations.md` still exclude managed cloud, billing, phone-home activation, Docker in the browser, direct TCP databases, native addons, arbitrary native binaries, arbitrary npm packages, and mobile Safari. This comparison does not change those boundaries.

## The capability that shipped

Command lists are on the existing shell step list. A desktop Chrome user can type `;` in the self-hosted editor terminal.

Observable result:

- `echo one; echo two` prints `one`, then `two`, and exits 0.
- `false; echo after` prints `after` and exits 0. The earlier non-zero exit does not skip the next command.
- `echo one; false` exits 2. The list exit code is the exit code of the last command that ran.
- `echo one; echo two | cat` runs `cat` on the command after `;`.
- `echo 'value;not-an-operator'` prints that text. A quoted semicolon stays a literal argument.
- `echo kept || echo skipped` still prints `kept` and exits 0. The second command does not run.
- `false | echo hi || echo recovered` still prints `recovered` and exits 0. A failed pipeline stage skips later `|` stages, and the `||` command still runs.
- `echo kept || echo skipped | cat` still prints `kept` and exits 0. The pipe belongs to the command that did not run, so `cat` does not run.
- `&`, command substitution, `>>`, `<`, and `{` stay syntax errors.

Append redirect and the other unsupported grammar entries stay unsupported. Background jobs and command substitution stay out because the release boundary already excludes host job control and a host shell.
