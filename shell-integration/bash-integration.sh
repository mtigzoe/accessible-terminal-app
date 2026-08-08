# Minimal bash "shell integration" for the accessible terminal app.
#
# Mirrors shell-integration/pwsh-integration.ps1: emits invisible OSC 633
# marker sequences around each prompt so the browser-side code
# (public/app-shell.js -> processOscMarkers) can find command boundaries
# and know whether the previous command succeeded -- the same thing that
# already works for PowerShell, now wired up for bash too.
#
# Loaded via `bash --rcfile shell-integration/bash-integration.sh -i`
# (see buildShellArgs in src/server.ts). --rcfile replaces the normal
# ~/.bashrc load for this session, so we source the user's own ~/.bashrc
# first (if present) and then set PROMPT_COMMAND/PS1 *after* that, so our
# markers always win over anything the user's bashrc does to the prompt.

# Guard against this file somehow getting sourced twice in the same shell.
if [ -n "$__ATS_INTEGRATION_LOADED" ]; then
  return 0 2>/dev/null || exit 0
fi
__ATS_INTEGRATION_LOADED=1
export __ATS_INTEGRATION_LOADED

if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc"
fi

__ats_prompt_cmd() {
  # Must be the very first statement, otherwise $? reflects something
  # this function ran instead of the command the user just ran.
  local exit_code=$?
  local ok=0
  [ "$exit_code" -eq 0 ] || ok=1

  # 633;D;<0|1>   - the previous command finished; 0 = succeeded, 1 = failed.
  # 633;A         - a new prompt is starting here.
  # 633;P;Cwd=... - explicit current directory, read by processOscMarkers()
  #                 in app-shell.js. Sent as its own marker (rather than
  #                 relying on matchPrompt() to regex it out of the visible
  #                 prompt text) because local echo of the command the user
  #                 just ran gets drawn on the same terminal line as the
  #                 *next* prompt, so an isolated, cleanly-matchable prompt
  #                 line isn't guaranteed after every command.
  # printf (not echo) so nothing adds a trailing newline before the prompt.
  printf '\033]633;D;%s\007\033]633;A\007\033]633;P;Cwd=%s\007' "$ok" "$PWD"
}

# Run our marker function first, then anything the sourced ~/.bashrc
# already put in PROMPT_COMMAND. Bash 5.1+ treats PROMPT_COMMAND as an
# array; older bash (still the default on stock macOS) only supports the
# plain string form.
if [ "${BASH_VERSINFO[0]}" -gt 5 ] || { [ "${BASH_VERSINFO[0]}" -eq 5 ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
  PROMPT_COMMAND=(__ats_prompt_cmd "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__ats_prompt_cmd${PROMPT_COMMAND:+; }$PROMPT_COMMAND"
fi

# Fixed, predictable prompt text so matchPrompt() in app-shell.js can pull
# the current path back out of it: user@host:/current/path$
#
# Known limitation: matchPrompt()'s regex requires the path to contain no
# whitespace ([^\s$#]+). A working directory with a space in it will fail
# to match and the app will just keep showing the last path it did see --
# everything else still works, the path readout just goes stale.
PS1='\u@\h:\w\$ '
