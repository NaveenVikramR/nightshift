# AWS resources (ap-southeast-2)

Everything here was created once by hand with the AWS CLI. Each create was approved first.
Replace `ACCOUNT_ID` and the email before you run anything. Neither is committed.

| File                         | Resource                                                                                             | Cost                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| `iam/app-access-policy.json` | policy `nightshift-app-access`: Nova Lite, ApplyGuardrail, Polly, CloudWatch `Nightshift`            | $0                      |
| `iam/app-trust-policy.json`  | role `nightshift-app` (used by alexa-sim locally and by the EC2 instance later)                      | $0                      |
| `iam/deny-ai-policy.json`    | policy `nightshift-deny-ai`: the kill switch (deny `bedrock:*`, `polly:*`)                           | $0                      |
| `iam/budgets-action-*.json`  | role `nightshift-budgets-action`: can attach only that deny policy to only `nightshift-app`          | $0                      |
| `budget.json`                | budget `nightshift-monthly-5usd`: email alerts at $1, $3 and $5 (actual); the kill switch runs at $5 | $0                      |
| `guardrail.json`             | Bedrock guardrail `nightshift-prompt-attack` (prompt-attack filter, input only)                      | $0.08 per 1K text units |

```sh
export AWS_PROFILE=nightshift AWS_REGION=ap-southeast-2 PYTHONUTF8=1
aws iam create-policy --policy-name nightshift-app-access --policy-document file://iam/app-access-policy.json
aws iam create-policy --policy-name nightshift-deny-ai --policy-document file://iam/deny-ai-policy.json
aws iam create-role --role-name nightshift-app --max-session-duration 3600 \
  --assume-role-policy-document file://iam/app-trust-policy.json
aws iam attach-role-policy --role-name nightshift-app \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/nightshift-app-access
aws iam create-role --role-name nightshift-budgets-action \
  --assume-role-policy-document file://iam/budgets-action-trust-policy.json
aws iam put-role-policy --role-name nightshift-budgets-action --policy-name attach-kill-switch \
  --policy-document file://iam/budgets-action-policy.json
aws budgets create-budget --account-id ACCOUNT_ID --budget file://budget.json \
  --notifications-with-subscribers '<$1, $3 and $5 ACTUAL alerts to your email>'
aws budgets create-budget-action --account-id ACCOUNT_ID --budget-name nightshift-monthly-5usd \
  --notification-type ACTUAL --action-type APPLY_IAM_POLICY --approval-model AUTOMATIC \
  --action-threshold ActionThresholdValue=100,ActionThresholdType=PERCENTAGE \
  --definition 'IamActionDefinition={PolicyArn=arn:aws:iam::ACCOUNT_ID:policy/nightshift-deny-ai,Roles=[nightshift-app]}' \
  --execution-role-arn arn:aws:iam::ACCOUNT_ID:role/nightshift-budgets-action \
  --subscribers SubscriptionType=EMAIL,Address=you@example.com
aws bedrock create-guardrail --cli-input-json file://guardrail.json
aws bedrock create-guardrail-version --guardrail-identifier <id>
```

To run locally as the app role, add this to `~/.aws/config` and start alexa-sim with
`AWS_PROFILE=nightshift-app`:

```ini
[profile nightshift-app]
role_arn = arn:aws:iam::ACCOUNT_ID:role/nightshift-app
source_profile = nightshift
region = ap-southeast-2
duration_seconds = 3600
```
