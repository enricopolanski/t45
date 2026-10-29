#!/bin/sh
# Builds the agent image with Docker and loads it into microsandbox as t45-agent:dev, the image
# the runner uses in development.
set -eu
cd "$(dirname "$0")/.."
vp pack
docker build -f image/Dockerfile -t t45-agent:dev .
docker save t45-agent:dev | msb load -t t45-agent:dev
