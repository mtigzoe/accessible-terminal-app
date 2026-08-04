# Minimal PowerShell "shell integration" for the accessible terminal app.
#
# Overrides the prompt function to emit invisible OSC 633 marker sequences
# around each prompt. These are never displayed - xterm.js's parser consumes
# them silently - but the browser-side code listens for them to find command
# boundaries and know whether the previous command succeeded, powering the
# "jump to previous/next command" navigation in the accessible view.
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

    Write-Host -NoNewline $marker

    "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
}

Write-Host "Shell integration active - command navigation available in the browser's accessible view (Alt+F2)."
