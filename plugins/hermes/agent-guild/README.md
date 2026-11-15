# Agent Guild for Hermes Agent

Shows every Hermes session live in [Agent Guild](https://github.com/oddessentials/agent-guild): Telegram, Discord, cron, CLI, the terminal app and Desktop sessions, their subagents, the shell commands they run and the approvals they wait for.

## Install

Add the Hermes Agent card in Agent Guild and turn on **Agent reporting** on it. For each profile it saves where Agent Guild keeps that profile's report token and its own address (`AGENT_GUILD_HERMES_TOKEN_FILE`, in the profile's `.env`) and installs this plugin with `hermes plugins install`. A running gateway loads it straight away.

## What it sends

Session, tool, subagent and approval events, including shell commands and subagent goals after Hermes's secret redaction (left out when it fails), only to the Agent Guild manager on this computer (default `http://127.0.0.1:47821`). It runs one background thread per profile that reports, reads one file, where Agent Guild keeps the profile's report token and its own address, and installs no packages.

Agent Guild shows the Hermes sessions that have been active since reporting started. A session that was already running appears at its next turn or tool call.
