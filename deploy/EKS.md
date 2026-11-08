# Running iExplore on EKS with Bedrock

iExplore runs as a **Kubernetes CronJob**: each run is one pod that pulls the learned state from S3, does one
exploratory session with Claude on Bedrock, refreshes coverage and triage, and pushes everything back to S3.
No service, no ingress, no database.

```
CronJob (hourly, suspended until you're happy)
  └─ pod (Playwright image, ~2 vCPU / 4 GB, IRSA role)
       ├─ Bedrock  ap-southeast-2  au.* Claude inference profile   (bedrock:InvokeModel)
       ├─ S3       s3://<bucket>/iexplore/prod-car/{knowledge,triage,runs}
       └─ HTTPS    www.comparethemarket.com.au  (tagged ?automated-test=true)
```

## Start on UAT (recommended)

UAT sits inside the corporate network, so there's no WAF to negotiate. Use the UAT overlay instead of the base:

```bash
kubectl apply -k deploy/k8s/overlays/uat        # instead of: kubectl apply -k deploy/k8s
```

Fill in `deploy/k8s/overlays/uat/config.yaml`:

| Setting | What to put |
|---|---|
| `IEXPLORE_START_URL` | the UAT car landing page, e.g. `https://<uat-host>/car-insurance/` |
| `IEXPLORE_HOST` | the UAT host; comma-separate any other hosts the journey moves to (quote, API, auth) |
| `IEXPLORE_STATE_PREFIX` | `iexplore/uat-car`, so UAT learning stays apart from prod. Don't copy the prod knowledge in |
| `IEXPLORE_ALLOW_SUBMISSION` | leave `false` for the first runs (see below) |
| `IEXPLORE_IGNORE_HTTPS_ERRORS` | `true` if UAT's certificate comes from an internal CA |
| `UAT_TEST_REGO_*` | real UAT test plates; rego lookup is allowed on UAT |

If UAT sits behind basic auth, add `UAT_BASIC_AUTH_USER` and `UAT_BASIC_AUTH_PASSWORD` to the `iexplore` secret.

**Quote submission on UAT is off by default.** The bot explores up to the contact-details step and stops there, as on
prod. Before turning it on, find out what a UAT quote triggers downstream (emails, SMS, insurer panel calls, CRM),
add those endpoints to `blocked_request_patterns` under `targets.uat` in `config/bot.yaml`, rebuild, then set
`IEXPLORE_ALLOW_SUBMISSION: "true"`. That unlocks the results page, where the price-consistency checks live.

UAT-specific checks:

- [ ] DNS: the pod resolves the UAT host (internal Route 53 zone or CoreDNS forwarding).
- [ ] NetworkPolicy: the `iexplore` namespace may reach the UAT ingress, plus Bedrock and S3 endpoints.
- [ ] If UAT runs in the same cluster, still use its normal hostname, not the Service name: the app, cookies
      and the guardrails all expect the real host.

## 1. AWS, once

```bash
ACCOUNT=<account-id>; REGION=ap-southeast-2; BUCKET=<bucket>; CLUSTER=<cluster>

# Model ID: the AU cross-region inference profile for Claude Sonnet (recommended for sessions; Opus also works)
aws bedrock list-inference-profiles --region $REGION \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude')].inferenceProfileId"

# Image registry and state bucket
aws ecr create-repository --repository-name iexplore --region $REGION
aws s3api create-bucket --bucket $BUCKET --region $REGION --create-bucket-configuration LocationConstraint=$REGION

# Prod only: seed the bucket with what the bot has already learned (2 prod sessions, 29 findings).
# UAT starts empty and learns its own map.
aws s3 sync knowledge s3://$BUCKET/iexplore/prod-car/knowledge
aws s3 sync triage    s3://$BUCKET/iexplore/prod-car/triage
```

IAM role `iexplore-runner` for the pod. Fill `<ACCOUNT_ID>`, `<BUCKET>` (and `<OIDC_PROVIDER>` for IRSA) in the files:

```bash
# IRSA (works on any EKS):
OIDC=$(aws eks describe-cluster --name $CLUSTER --query "cluster.identity.oidc.issuer" --output text | sed 's|https://||')
aws iam create-role --role-name iexplore-runner --assume-role-policy-document file://deploy/iam/trust-irsa.json
#   ...or EKS Pod Identity: use trust-pod-identity.json, then
#   aws eks create-pod-identity-association --cluster-name $CLUSTER --namespace iexplore \
#     --service-account iexplore --role-arn arn:aws:iam::$ACCOUNT:role/iexplore-runner
aws iam put-role-policy --role-name iexplore-runner --policy-name iexplore \
  --policy-document file://deploy/iam/runner-policy.json
```

The policy allows only: invoking Claude through `au.*` inference profiles, and reading/writing `s3://<bucket>/iexplore/*`.
If your S3 prefix differs, change it in both the policy and `IEXPLORE_STATE_PREFIX`.

## 2. Build the image

Either run the **image** GitHub workflow (needs `vars.AWS_ECR_ROLE_ARN`: an OIDC role allowed to push to ECR), or:

```bash
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/amd64 -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/iexplore:latest .
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/iexplore:latest
```

Use `--platform linux/arm64` if your nodes are Graviton; the Playwright image supports both.

## 3. Deploy

Fill the placeholders, then apply:

| File | What to set |
|---|---|
| `deploy/k8s/configmap.yaml` | `BEDROCK_MODEL_ID`, `IEXPLORE_STATE_BUCKET` (and ADO org/project later) |
| `deploy/k8s/serviceaccount.yaml` | role ARN (IRSA) or remove the annotation (Pod Identity) |
| `deploy/k8s/kustomization.yaml` | ECR image name/tag |
| `deploy/k8s/*-job.yaml` | ECR image |

```bash
kubectl apply -k deploy/k8s
kubectl -n iexplore create secret generic iexplore --from-literal=ADO_PAT=<pat>   # only when connecting ADO
```

## 4. Preflight, then one session by hand

```bash
kubectl create -f deploy/k8s/check-job.yaml          # prints job.batch/iexplore-check-xxxxx created
kubectl -n iexplore logs -f job/iexplore-check-xxxxx
#   provider bedrock · model au.anthropic... · region ap-southeast-2 · tool legacy
#   OK in 1840 ms · reply "OK" · ...
#   state bucket s3://<bucket>/iexplore/prod-car: 3 knowledge file(s) readable

kubectl -n iexplore create job iexplore-manual-1 --from=cronjob/iexplore
kubectl -n iexplore logs -f job/iexplore-manual-1
```

The run's report, screenshots and trace land in `s3://<bucket>/iexplore/prod-car/runs/<run-id>/`, the coverage
heatmap in `knowledge/coverage.html` and the triage pack in `triage/prod-car.html`.

If the check fails with a validation error about the `computer` tool, switch `model.bedrock.tool_version` in
`config/bot.yaml` (legacy ↔ toolset) and rebuild. An `AccessDenied` means the role policy or the model ID is wrong.

## 5. Switch on the schedule

```bash
kubectl -n iexplore patch cronjob iexplore -p '{"spec":{"suspend":false}}'   # hourly at :17
kubectl -n iexplore patch cronjob iexplore -p '{"spec":{"suspend":true}}'    # pause
```

`concurrencyPolicy: Forbid` means two sessions never overlap. Don't also run the GitHub `iexplore` workflow against
prod: it keeps its own state on the `bot-knowledge` branch.

## 6. Triage and ADO

```bash
aws s3 cp s3://$BUCKET/iexplore/prod-car/triage/prod-car.csv .     # edit the decision column
aws s3 cp prod-car.csv s3://$BUCKET/iexplore/prod-car/triage/prod-car.csv
kubectl create -f deploy/k8s/ado-sync-job.yaml                       # dry run; --apply to create bugs
```

Edits uploaded while a session is running are kept: the job re-reads the register just before saving.

## Network and platform checklist

- [ ] Egress to `www.comparethemarket.com.au` (and the third-party hosts in `allowed_hosts`), Bedrock, S3, ECR.
      Private cluster: VPC endpoints for `bedrock-runtime`, `s3` (gateway), `ecr.api`, `ecr.dkr`, `sts`.
- [ ] Cloudflare/WAF: allowlist the user agent `CTM-PersonaBot` or the cluster's NAT IPs, or sessions may get challenged.
- [ ] The image is public `mcr.microsoft.com/playwright`; mirror it if your cluster only pulls from approved registries.
- [ ] Pod security: runs as non-root (uid 1001), no privilege escalation, all capabilities dropped. Playwright starts
      Chromium without its own sandbox by default, so no extra privileges are needed; the pod is the isolation boundary.

## Cost

Compute is small: one ~2 vCPU pod for up to 15 minutes an hour. Bedrock tokens are the real cost, mostly
screenshots. `model.keep_screenshots` and `budgets.max_input_tokens` in `config/bot.yaml` cap each session; watch
the token line in each run's report for the first few days. Start on Sonnet; Opus costs more per token and is
worth trying only if Sonnet misses things.
