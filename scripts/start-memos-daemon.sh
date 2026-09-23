#!/bin/bash
# start-memos-daemon.sh — 以脱离终端/父进程的方式启动 memos daemon。
# PID 文件守卫会自动 SIGTERM 旧 daemon 并接管 18800 端口。
cd /home/leslie/.hermes/memos-plugin
setsid nohup /home/leslie/.hermes/node/bin/node node_modules/.bin/tsx bridge.cts --agent=hermes --daemon >> logs/daemon-start.log 2>&1 < /dev/null &
echo "memos daemon launched, pid=$!"
