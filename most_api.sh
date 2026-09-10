#!/bin/bash
# Slurm directives must be at the top, before any commands.
# Do NOT put --nodelist here if you want it to come from the environment;
# pass it via `sbatch --nodelist=... run_api.sh` instead (see scripts/submit_api.sh).
#SBATCH --cpus-per-task=1

source .env

npm install
npm start
