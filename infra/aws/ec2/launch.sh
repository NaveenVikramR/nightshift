#!/usr/bin/env bash
# PRINTS (does not run) the one-time AWS CLI commands that create the Nightshift EC2 host in
# ap-southeast-2: a key pair, a security group (22 from your IP, 80, 443), an instance profile
# for the nightshift-app role, and a t3.micro with Ubuntu 24.04 on 16 GB gp3. Review, then run
# them yourself (each is a create; see the costs below and in infra/aws/README.md).
#
#   bash infra/aws/ec2/launch.sh            # your IP is looked up with checkip.amazonaws.com
#   MY_IP=203.0.113.7 bash infra/aws/ec2/launch.sh
#
# Then: ssh ubuntu@<ip>, run infra/deploy/bootstrap.sh <repo-url> <domain>, fill the env files,
# set NIGHTSHIFT_IMAGE_PREFIX in deploy.env (pull GHCR images: no build on a 1 GB host) and
# run up.sh. Stop it when you're not demoing: infra/aws/ec2/stop.sh.
set -euo pipefail

REGION=ap-southeast-2
NAME=nightshift
MY_IP=${MY_IP:-$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')}
[[ $MY_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "set MY_IP=<your IPv4>" >&2; exit 1; }

cat <<EOF
# Costs (Sydney, on-demand; on the free plan these draw down your credits):
#   t3.micro  \$0.0132/h while running (~\$9.64/month if never stopped)
#   public IPv4  \$0.005/h while running (~\$3.65/month); released when stopped
#   16 GB gp3  \$0.096/GB-month = ~\$1.54/month, billed even while stopped
#   key pair, security group, instance profile: \$0

export AWS_PROFILE=nightshift AWS_REGION=$REGION PYTHONUTF8=1

# 1. SSH key (the private key is written once to ~/.ssh; AWS keeps only the public key).
aws ec2 create-key-pair --key-name $NAME --key-type ed25519 \\
  --query KeyMaterial --output text > ~/.ssh/$NAME.pem && chmod 600 ~/.ssh/$NAME.pem

# 2. Security group in the default VPC: SSH from your IP only; HTTP/HTTPS for Caddy.
SG=\$(aws ec2 create-security-group --group-name $NAME --description "Nightshift host" \\
  --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "\$SG" --protocol tcp --port 22 --cidr $MY_IP/32
aws ec2 authorize-security-group-ingress --group-id "\$SG" --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id "\$SG" --protocol tcp --port 443 --cidr 0.0.0.0/0

# 3. Instance profile for the existing nightshift-app role (Bedrock, Guardrail, Polly, CloudWatch).
aws iam create-instance-profile --instance-profile-name nightshift-app
aws iam add-role-to-instance-profile --instance-profile-name nightshift-app --role-name nightshift-app

# 4. The instance. IMDSv2 only; hop limit 2 so the containers can reach the instance role.
AMI=\$(aws ssm get-parameter \\
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \\
  --query Parameter.Value --output text)
aws ec2 run-instances --image-id "\$AMI" --instance-type t3.micro --key-name $NAME \\
  --security-group-ids "\$SG" --iam-instance-profile Name=nightshift-app \\
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=16,VolumeType=gp3,DeleteOnTermination=true}' \\
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled \\
  --credit-specification CpuCredits=standard \\
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]' \\
  --query 'Instances[0].InstanceId' --output text

# 5. Wait and print the address (DuckDNS: infra/deploy/duckdns.sh keeps the name pointed at it).
bash infra/aws/ec2/start.sh
EOF
