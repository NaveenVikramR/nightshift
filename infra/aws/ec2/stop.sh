#!/usr/bin/env bash
# Stops the Nightshift EC2 host (tag Name=nightshift) and waits until it is stopped.
# Stopped: no instance-hours and no public IPv4 charge. Still billed: the 16 GB gp3 volume
# (~$1.54/month), any EBS snapshots, and an Elastic IP if you ever allocate one.
#   AWS_PROFILE=nightshift bash infra/aws/ec2/stop.sh
set -euo pipefail
export AWS_REGION=${AWS_REGION:-ap-southeast-2} PYTHONUTF8=1

id=$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=nightshift Name=instance-state-name,Values=pending,running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [[ -z $id || $id == None ]]; then
  echo "nothing running"
  exit 0
fi
# shellcheck disable=SC2086 # one or more ids, space-separated
aws ec2 stop-instances --instance-ids $id >/dev/null
# shellcheck disable=SC2086
aws ec2 wait instance-stopped --instance-ids $id
echo "stopped: $id"
