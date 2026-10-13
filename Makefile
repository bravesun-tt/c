SHELL := /bin/sh

HOST ?= 127.0.0.1
PORT ?= 3000
PID_FILE := .next/server.pid
LOG_FILE := .next/server.log

.PHONY: start stop restart status logs

start:
	@mkdir -p .next
	@if [ -f "$(PID_FILE)" ] && kill -0 "$$(cat "$(PID_FILE)")" 2>/dev/null; then \
		echo "Server is already running (PID $$(cat "$(PID_FILE)"))"; \
		exit 0; \
	fi
	@if command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$(PORT)" -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Port $(PORT) is already in use; server was not started"; \
		exit 1; \
	fi
	@rm -f "$(PID_FILE)"
	@echo "Starting Next.js at http://$(HOST):$(PORT)"
	@(npm run dev -- --hostname "$(HOST)" --port "$(PORT)" >"$(LOG_FILE)" 2>&1 & echo $$! >"$(PID_FILE)")
	@echo "Server started (PID $$(cat "$(PID_FILE)")); logs: $(LOG_FILE)"

stop:
	@if [ ! -f "$(PID_FILE)" ]; then \
		echo "Server is not running"; \
		exit 0; \
	fi
	@pid="$$(cat "$(PID_FILE)")"; \
	if kill -0 "$$pid" 2>/dev/null; then \
		echo "Stopping server (PID $$pid)"; \
		kill "$$pid"; \
		for i in 1 2 3 4 5 6 7 8 9 10; do \
			kill -0 "$$pid" 2>/dev/null || break; \
			sleep 1; \
		done; \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Server did not stop gracefully; sending SIGKILL"; \
			kill -KILL "$$pid" 2>/dev/null || true; \
		fi; \
	else \
		echo "Stale PID file found"; \
	fi
	@rm -f "$(PID_FILE)"

restart: stop start

status:
	@if [ -f "$(PID_FILE)" ] && kill -0 "$$(cat "$(PID_FILE)")" 2>/dev/null; then \
		echo "Server is running (PID $$(cat "$(PID_FILE)")) at http://$(HOST):$(PORT)"; \
	elif command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$(PORT)" -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "A server is listening on port $(PORT) (not managed by this Makefile)"; \
	else \
		echo "Server is not running"; \
	fi

logs:
	@if [ -f "$(LOG_FILE)" ]; then \
		tail -f "$(LOG_FILE)"; \
	else \
		echo "No log file found: $(LOG_FILE)"; \
	fi
