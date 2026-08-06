#!/usr/bin/env bash
set -uo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 72
plugin_root=$(realpath -- "$script_dir/..") || exit 72
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

if [[ ! -d $runtime_dir || ! -w $runtime_dir ]]; then
  printf 'build_runtime_lock_directory_unavailable: %s\n' "$runtime_dir" >&2
  exit 72
fi

root_digest=$(printf '%s' "$plugin_root" | sha256sum | awk '{print $1}') || exit 72
lock_path="$runtime_dir/codex-discord-build-runtime-$root_digest.lock"
compat_lock_path="$runtime_dir/codex02-discord-build-runtime.lock"
node_bin=$(command -v node) || {
  printf 'build_runtime_node_not_found\n' >&2
  exit 72
}

if [[ ! -e $lock_path && ! -e $compat_lock_path ]]; then
  : >"$compat_lock_path" || exit 72
  ln -- "$compat_lock_path" "$lock_path" 2>/dev/null || [[ -e $lock_path ]] || exit 72
elif [[ ! -e $lock_path ]]; then
  ln -- "$compat_lock_path" "$lock_path" 2>/dev/null || [[ -e $lock_path ]] || exit 72
elif [[ ! -e $compat_lock_path ]]; then
  ln -- "$lock_path" "$compat_lock_path" 2>/dev/null || [[ -e $compat_lock_path ]] || exit 72
fi

exec 8>"$compat_lock_path" || exit 72
exec 9>"$lock_path" || exit 72
set +e
/usr/bin/flock --nonblock --conflict-exit-code=73 8
rc=$?
if [[ $rc -eq 0 && $(stat -Lc '%d:%i' "$compat_lock_path") != $(stat -Lc '%d:%i' "$lock_path") ]]; then
  /usr/bin/flock --nonblock --conflict-exit-code=73 9
  rc=$?
fi
set -e
if [[ $rc -ne 0 ]]; then
  if [[ $rc -eq 73 ]]; then
    printf 'build_runtime_already_running\n' >&2
  fi
  exit "$rc"
fi

export CODEX_DISCORD_BUILD_WRAPPER_HELD=1

# Only the lock owner may reap abandoned private build directories or recover
# an interrupted two-file publish. A direct Node invocation never deletes a
# peer's temporary output.
shopt -s nullglob
for stale_directory in "$runtime_dir/codex-discord-build-runtime-$root_digest-"??????; do
  [[ -d $stale_directory && ! -L $stale_directory ]] || continue
  /usr/bin/find -P "$stale_directory" -xdev -depth -delete || exit 72
done
shopt -u nullglob

"$node_bin" "$plugin_root/scripts/build-runtime.js" --recover-publish || exit 72

temporary_directory=$(mktemp -d "$runtime_dir/codex-discord-build-runtime-$root_digest-XXXXXX") || exit 72
chmod 700 "$temporary_directory" || exit 72
export CODEX_DISCORD_BUILD_TEMPORARY_DIRECTORY=$temporary_directory

cleanup_temporary_directory() {
  case "$temporary_directory" in
    "$runtime_dir/codex-discord-build-runtime-$root_digest-"??????) ;;
    *)
      printf 'build_runtime_refused_unsafe_cleanup: %s\n' "$temporary_directory" >&2
      return 72
      ;;
  esac
  if [[ -d $temporary_directory ]]; then
    /usr/bin/find -P "$temporary_directory" -xdev -depth -delete
  fi
}

child_pid=
forward_signal() {
  local signal=$1
  if [[ -n $child_pid ]]; then kill -s "$signal" "$child_pid" 2>/dev/null || true; fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP

# The wrapper remains a small lock-owning supervisor. If the memory-heavy Node
# child is terminated or selected by the OOM killer, wait returns and the
# private output directory is removed before the kernel locks are released.
"$node_bin" "$plugin_root/scripts/build-runtime.js" "$@" &
child_pid=$!
set +e
while true; do
  wait "$child_pid"
  rc=$?
  if ! kill -0 "$child_pid" 2>/dev/null; then break; fi
done
set -e
recovery_rc=0
"$node_bin" "$plugin_root/scripts/build-runtime.js" --recover-publish || recovery_rc=$?
cleanup_rc=0
cleanup_temporary_directory || cleanup_rc=$?
if [[ $recovery_rc -ne 0 || $cleanup_rc -ne 0 ]]; then exit 72; fi
exit "$rc"
