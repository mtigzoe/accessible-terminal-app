# Minimal PowerShell "shell integration" for the accessible terminal app.
#
# Overrides the prompt function to emit invisible OSC 633 marker sequences
# around each prompt. These are never displayed - the browser-side code
# listens for them to find command boundaries and know whether the previous
# command succeeded.
#
# Loosely follows the OSC 633 convention used by VS Code's own shell
# integration scripts. [char]27/[char]7 are used instead of the `e/`a
# backtick escapes since those aren't available in Windows PowerShell 5.1.

function prompt {
    # Must be the very first statement, otherwise $? reflects this
    # function's own execution instead of the command that just ran.
    $exitOk = $?

    $esc = [char]27
    $bel = [char]7

    # 633;D;<0|1> - the previous command finished; 0 = succeeded, 1 = failed.
    $marker = "$esc]633;D;$(if ($exitOk) { 0 } else { 1 })$bel"
    # 633;A - a new prompt is starting here.
    $marker += "$esc]633;A$bel"
    # 633;P;Cwd=... - explicit current directory. Sent as its own marker
    # (rather than relying on matchPrompt() regexing it back out of the
    # visible "PS <path>>" text) because local echo of the command just
    # run can land on the same terminal line as the next prompt, so an
    # isolated, cleanly-matchable prompt line isn't guaranteed every time.
    $marker += "$esc]633;P;Cwd=$($executionContext.SessionState.Path.CurrentLocation)$bel"

    Write-Host -NoNewline $marker

    "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
}
