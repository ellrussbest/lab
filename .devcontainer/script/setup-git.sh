#!/usr/bin/env bash
set -e

echo "Checking GitHub CLI authentication..."
if gh auth status >/dev/null 2>&1; then
  echo "SUCCESS: GitHub CLI already authenticated"
else
  echo "NOTICE: Not authenticated — starting gh auth login"
  gh auth login
fi

echo "Fetching GitHub user info..."
GH_LOGIN="$(gh api user -q .login)"
GIT_NAME="$(gh api user -q '.name // .login')"
GIT_EMAIL="$(gh api user -q '.email // empty')"

if [ -z "$GIT_EMAIL" ]; then
  echo "WARNING: GitHub email not public — using noreply address"
  GIT_EMAIL="${GH_LOGIN}@users.noreply.github.com"
fi

echo "Removing empty local git identity (if any)..."
git config --local --unset user.name  2>/dev/null || true
git config --local --unset user.email 2>/dev/null || true

echo "Configuring git identity..."
git config --local user.name "$GIT_NAME"
git config --local user.email "$GIT_EMAIL"

echo "Configuring git to use GitHub CLI credentials..."
gh auth setup-git

echo "Git setup complete."
git config --list | grep '^user\.'