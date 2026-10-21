#!/usr/bin/env bash
# Starts the Nightshift EC2 host (tag Name=nightshift), waits until it runs, prints its public IP.
# Billing resumes: instance-hours ($0.0132/h) and its public IPv4 ($0.005/h).
#   AWS_PROFILE=nightshift bash infra/aws/ec2/start.sh
set -euo pipefail
export AWS_REGION=${AWS_REGION:-ap-southeast-2} PYTHONUTF8=1

id=$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=nightshift Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[[ -n $id && $id != None ]] || { echo "no instance tagged Name=nightshift in $AWS_REGION" >&2; exit 1; }
[[ $id != *[[:space:]]* ]] || { echo "more than one instance tagged nightshift: $id" >&2; exit 1; }

state=$(aws ec2 describe-instances --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
[[ $state != stopping ]] || aws ec2 wait instance-stopped --instance-ids "$id"
[[ $state == running || $state == pending ]] || aws ec2 start-instances --instance-ids "$id" >/dev/null
aws ec2 wait instance-running --instance-ids "$id"
ip=$(aws ec2 describe-instances --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "running: $id  public IP $ip"
echo "DuckDNS updates itself within 5 minutes (cron); the containers restart with Docker."
