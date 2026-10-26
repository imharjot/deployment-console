# Costs & usage

**Costs** in the sidebar puts two numbers side by side: what AWS actually charges, read from **Cost Explorer**, and
what is running right now priced at list — an **estimate** that is free, instant and works without Cost Explorer.

Costs are sensitive: the page, its API and the agent operations need the **operator** role or higher (the `costs`
permission). Viewers and developers see a note instead of numbers.

**What you'll need**: the `CostsRead` statement (already in both shipped policies) and Cost Explorer enabled in the
account. The estimate works without either. See [Setting it up](#setting-it-up).

## What the page shows

| Section | Source | What it says |
|---|---|---|
| **Month to date** | Cost Explorer | spend since the 1st, including today so far |
| **Forecast · month end** | Cost Explorer | full days so far + AWS's forecast for the rest of the month |
| **Last month** | Cost Explorer | last month's full total |
| **vs same point last month** | Cost Explorer | this month's full days against the same number of days last month |
| **Daily spend** | Cost Explorer | the last 30 days; today is faint (still counting), days in an open anomaly are tinted |
| **By AWS service** | Cost Explorer | month to date per service, with last month for comparison |
| **By environment** | Cost Explorer + cost allocation tags | month to date per environment, plus everything without the tag |
| **By ECS service** | Cost Explorer + split cost allocation data | month to date per ECS service and environment |
| **Anomalies** | AWS Cost Anomaly Detection | what AWS flagged in the last 30 days, with its impact and root cause |
| **Spikes** | the console | AWS services whose daily average over the last 7 days is more than 30 % above the 21 days before, and at least $1 a day more |
| **Estimated monthly run rate** | discovery × list prices | per environment and resource, USD per month |

## Where the numbers come from

### Actual spend

- **Unblended cost in USD**, with **credits and refunds left out** (so promotional credits don't hide what running
  costs) and tax left in. Days are UTC, as in Cost Explorer.
- AWS updates cost data a few times a day, and marks the open month as *estimated* until the invoice closes. Today's
  numbers are partial.
- **Forecast**: AWS forecasts the rest of the month (`GetCostForecast`). New accounts don't have enough history for
  that; then the console projects the last 7 full days' average and says so. AWS's model learns from months of
  history, so it lags a recent change: when the daily spend it assumes is over twice (or under half) the last 7 days'
  average — services scaled to zero mid-month, say — the tile also shows where the 7-day run rate ends the month.
- **By environment** groups spend by the cost allocation tag `aws:ecs:clusterName` and maps each cluster to its
  environment through discovery. Clusters that aren't a discovered environment show under their own name.
  Everything without the tag — RDS, NAT gateways, load balancers, S3, … — is one **shared & untagged** row. To split
  those too, tag your resources with a tag of your own (for example `env=production`) and set `costs.tagKey`; values
  may be an environment id, its label or its cluster name.
- **By ECS service** uses `aws:ecs:serviceName`. With split cost allocation data, AWS splits Fargate costs by task and
  EC2 instance costs by the CPU and memory each task reserves.
- **Anomalies** come from AWS Cost Anomaly Detection, which only reports on the monitors you create (free, in Billing
  and Cost Management).
- **Spikes** are the console's own check on the daily data it already has: no extra requests.

### Estimated run rate

What discovery sees running, times on-demand list prices, times 730 hours:

| Resource | Priced as |
|---|---|
| Fargate service | task CPU and memory × running tasks; ARM64 (Graviton) task definitions 20 % less |
| Service on EC2 | not priced on its own — *on host*: its cost is the instance's |
| EC2 host | instance type; stopped instances count as $0 (their EBS volumes are still billed) |
| RDS instance | instance class, doubled for Multi-AZ; stopped instances count as $0 |
| ElastiCache | node type × nodes; Valkey 20 % less than Redis OSS |

Prices are Linux on-demand list prices of the region each resource runs in, from the AWS Price List
(`src/lib/list-prices.ts`; refresh it with `node scripts/list-prices.mjs`, which needs `pricing:GetProducts`). A region
missing from that table is priced as us-east-1, and each environment says whose prices it used. Sizes the table doesn't
know show *no list price* and are left out of the total rather than guessed. Fargate rates and a multiplier can be set
under `pricing` (below).

Besides the ECS environments, the estimate counts what the resource inventory places elsewhere: EC2 instances outside
any cluster, and the databases and caches of environments known only from tags (an EC2 box and its database tagged
`Environment=staging`) or of no environment.

## Estimates vs actuals

They answer different questions and will not match. The estimate is *what runs now, at list price*: it leaves out data
transfer, storage (EBS, RDS storage, S3, snapshots), load balancers, NAT gateways, CloudWatch, public IPv4 addresses
and every discount (Savings Plans, Reserved Instances, Spot, free tier). Actual spend is the whole account, all regions
and all services, as billed. Use the estimate to compare environments by what they run and to see what a resource
costs; use actual spend for the bill.

## Setting it up

1. **Permissions** — the `CostsRead` statement (`ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:GetAnomalies`) is in
   both shipped policies; see [Connect AWS](connect-aws.md#costs).
2. **Enable Cost Explorer** — open Billing and Cost Management → Cost Explorer once as an account administrator. It
   is free; data appears within 24 hours. In an AWS Organizations member account, the management account must allow
   member accounts to use Cost Explorer.
3. **Per-environment and per-service spend** — turn on *split cost allocation data* for Amazon ECS (Billing and Cost
   Management → Cost Management preferences) and activate the AWS-generated cost allocation tags
   `aws:ecs:clusterName` and `aws:ecs:serviceName` (Billing and Cost Management → Cost allocation tags). Data starts
   within 24 hours of activation and is **not back-filled**.
4. **Anomalies** (optional) — create a monitor in Billing and Cost Management → Cost Anomaly Detection.

Until a step is done, its section says what is missing and how to fix it; the rest of the page keeps working.

## What it costs

Every Cost Explorer API request costs **$0.01**, so the console is careful with them:

- One **snapshot** is 4 requests: daily spend by service (since the start of last month), this month by environment and
  ECS service tag, the forecast, and anomalies. A result that pages adds a request per page (bounded).
- A snapshot is taken **only when someone opens the page** (or an agent asks) and the last one is older than
  `costs.cacheHours` (6 hours). Nobody looks, nothing is spent.
- It is kept in memory **and** in the console's database (`settings` key `costs:snapshot`), so restarts, deploys and
  other console instances on the same Postgres reuse it instead of paying again.
- **Worst case with the defaults**: 4 requests × 4 snapshots a day × 30 days ≈ **$4.80 a month**, if the page is opened
  at least every 6 hours around the clock.
- **Refresh** takes a new snapshot at once: operator role, **once per 5 minutes across all users** (counting automatic
  snapshots too), and written to the audit log (`costs.refresh`, with the number of requests). The button's tooltip
  shows the cost.
- After a failed snapshot (no permission, Cost Explorer not enabled, throttling), page loads wait 15 minutes before
  trying again; Refresh can retry sooner.

The estimate makes no billed calls at all.

## Configuration

All optional, in `console.config.json`:

```json
{
  "pricing": { "multiplier": 1.1 },
  "costs": { "tagKey": "aws:ecs:clusterName", "spikePercent": 30, "cacheHours": 6 }
}
```

| Key | Default | Meaning |
|---|---|---|
| `pricing.fargateVcpuHour` | the region's list price | USD per Fargate vCPU-hour (x86; ARM is 20 % less) |
| `pricing.fargateGbHour` | the region's list price | USD per Fargate GB-hour |
| `pricing.multiplier` | `1` | applied to every estimate, Fargate rates included — e.g. `0.8` for a 20 % discount |
| `costs.tagKey` | `aws:ecs:clusterName` | cost allocation tag that splits spend by environment |
| `costs.spikePercent` | `30` | spike threshold, in percent |
| `costs.cacheHours` | `6` | how long a snapshot is reused, 1–168 hours (a value outside that range is reported under **Settings → Environments** and the default is used) |

## API and agents

| Endpoint / operation | What it does |
|---|---|
| `GET /api/costs` | snapshot view + estimate (`CostsView` in `src/lib/spend.ts`); takes a snapshot only if the stored one expired |
| `POST /api/costs/refresh` | new snapshot now; `429` within 5 minutes of the last one |
| `costs.summary` | compact JSON for agents: month to date, forecast, last month, change, top services and environments, anomalies, spikes |
| `costs.estimate` | the run rate per environment and resource; optional `env` |
| `costs.refresh` | a new snapshot (risk *change*: it spends a few cents) |

## Limitations

- **Account-wide actuals.** Cost Explorer reports the whole account across all regions; the estimate covers what the
  console discovers in its one region. If the console runs in an Organizations **management account**, Cost Explorer
  returns the spend of every member account, and the console does not filter it.
- **Shared costs** (RDS, NAT gateways, load balancers, data transfer) are only split by environment if you tag them
  yourself and point `costs.tagKey` at that tag.
- **Tags are not back-filled**: after activating them, the per-environment and per-service views fill in from that day.
- **Estimates** use on-demand list prices: no Spot (Fargate Spot is priced as on-demand), Savings Plans, Reserved
  Instances or free tier; Linux only; Aurora Serverless and unknown instance sizes are not priced.
- **USD** and the standard AWS partition only (Cost Explorer in China and GovCloud uses other endpoints).
- The Cost Explorer calls follow the SDK's documented request shapes and have been exercised against the simulated
  account; try a staging account first.
