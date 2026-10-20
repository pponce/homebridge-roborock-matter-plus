{
  echo "START COPY HERE"
  rr_repo="https://github.com/pponce/homebridge-roborock-matter-plus.git"
  rr_branch="SCHEDULE_PAUSE_DELAY"
  rr_commit="465ff53012d6b3f2904356dd8b29f5f8f64a2428"
  rr_ready=0

  if ! cd "$HOME/devProjects/homebridge-roborock-matter-plus"; then
    echo "ERROR: Cannot enter the repository. Update skipped."
  else
    echo "===== LOCAL GIT ====="
    if ! git branch --show-current || ! git status --short --branch; then
      echo "ERROR: Cannot inspect the repository."
    elif ! rr_changes=$(git status --porcelain); then
      echo "ERROR: Cannot check for local changes."
    elif [ -n "$rr_changes" ]; then
      echo "ERROR: Local changes found. Commit or stash them, then rerun."
    elif ! git fetch "$rr_repo" "$rr_branch"; then
      echo "ERROR: Fetch failed."
    elif ! (
      if git show-ref --verify --quiet "refs/heads/$rr_branch"; then
        git switch "$rr_branch"
      else
        git switch --create "$rr_branch" "$rr_commit"
      fi
    ); then
      echo "ERROR: Cannot switch to $rr_branch."
    elif ! git merge --ff-only "$rr_commit"; then
      echo "ERROR: Local history differs. Return this output; no reset was attempted."
    elif ! rr_head=$(git rev-parse HEAD); then
      echo "ERROR: Cannot verify the checked-out commit."
    elif [ "$rr_head" != "$rr_commit" ]; then
      echo "ERROR: Local branch contains additional commits. Install skipped."
    else
      rr_ready=1
      echo "Git update exit status: 0 ($rr_head)"
    fi

    if [ "$rr_ready" -eq 1 ]; then
      echo "===== HOMEBRIDGE UPDATE ====="
      sudo hb-service stop
      rr_stop=$?
      echo "hb-service stop exit status: $rr_stop"
      if [ "$rr_stop" -eq 0 ]; then
        sudo hb-service add "$rr_repo#$rr_commit"
        rr_add=$?
        echo "hb-service add exit status: $rr_add"
      else
        echo "Install skipped because Homebridge did not stop successfully."
      fi
      sudo hb-service start
      rr_start=$?
      echo "hb-service start exit status: $rr_start"
    else
      echo "Git update exit status: 1; Homebridge was not changed."
    fi
  fi
  echo "END COPY HERE"
}
