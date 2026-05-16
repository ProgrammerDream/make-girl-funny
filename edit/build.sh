#!/usr/bin/env bash
# 一键合成。需要先跑过 node record.js 生成 raw/*.webm
set -e
cd "$(dirname "$0")"
node build.js
