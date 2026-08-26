# Running ccledger on AWS

The cheapest way to keep ccledger up is an AWS Lightsail instance: $5 a month,
flat, in most regions. This page is that, end to end.

If you want the Docker stack instead, or you are not on AWS,
[install.md](install.md) covers both other modes.

## What it costs

Prices below are from the Lightsail and EC2 pricing APIs for `ap-south-1`
(Mumbai) and will differ by region. Check yours with:

```console
$ aws lightsail get-bundles --region ap-south-1 \
    --query 'bundles[?supportedPlatforms[0]==`LINUX_UNIX`]|[?price<`15`].{USD:price,RAM:ramSizeInGb,SSD:diskSizeInGb,id:bundleId}' \
    --output table

-------------------------------------------------
|                  GetBundles                   |
+-------+-------+------------------+------------+
|  RAM  |  SSD  |        id        |    USD     |
+-------+-------+------------------+------------+
|  0.5  |  20   |  nano_3_1        |  5.0       |
|  1.0  |  40   |  micro_3_1       |  7.0       |
|  2.0  |  60   |  small_3_1       |  12.0      |
|  0.5  |  20   |  nano_ipv6_3_1   |  3.5       |
|  1.0  |  40   |  micro_ipv6_3_1  |  5.0       |
|  2.0  |  60   |  small_ipv6_3_1  |  10.0      |
+-------+-------+------------------+------------+
```

| Option                           | Per month | Notes                                                                |
| -------------------------------- | --------- | -------------------------------------------------------------------- |
| **Lightsail `nano_3_1`**         | **$5.00** | 512 MB, 2 vCPU, 20 GB SSD, static IPv4 included. What this page uses |
| Lightsail `nano_ipv6_3_1`        | $3.50     | The same machine with no IPv4 address                                |
| EC2 `t4g.nano` + 8 GB EBS + IPv4 | ~$6.40    | $2.04 instance, ~$0.70 disk, $3.65 for the address                   |

Two things worth knowing before you pick the cheaper-looking options.

**EC2 is not cheaper.** The instance is, at $2.04, but a public IPv4 address has
been billable since February 2024 at $0.005 an hour — $3.65 a month, everywhere
— and that wipes out the difference. You also assemble the VPC, security group,
volume and elastic IP yourself, where Lightsail is one call.

**The IPv6-only tier will not work for most teams.** It saves $1.50 and takes
away the IPv4 address. Every teammate's network then has to have working IPv6 to
reach the server at all, and a laptop on a mobile hotspot or an office network
without it just cannot report. Only take this if you know every machine on the
team has IPv6.

**512 MB is enough to run ccledger and not enough to build it.** The Docker
image in `docker/` compiles a native SQLite addon and runs a Vite build, and
both run out of memory on a nano. That is why this page installs the published
npm package instead — it is a download, not a build. If you specifically want
the Docker stack, take `micro_3_1` at $7 or build the image elsewhere.

## 1. Pick a region near your team

Latency barely matters here — telemetry is exported in background batches — but
the region decides the price and where the data sits. For a team in South Asia
that is `ap-south-1`. List them with `aws lightsail get-regions --query
'regions[].name' --output table`.

## 2. Create the instance

```console
$ aws lightsail create-instances \
    --region ap-south-1 \
    --instance-names ccledger \
    --availability-zone ap-south-1a \
    --blueprint-id ubuntu_24_04 \
    --bundle-id nano_3_1
```

The command returns an `operations` array; the instance takes a minute or so to
reach `running`. Watch for it:

```console
$ aws lightsail get-instance-state --region ap-south-1 --instance-name ccledger
{
    "state": {
        "code": 16,
        "name": "running"
    }
}
```

`ubuntu_24_04` is the blueprint this page is written against. `aws lightsail
get-blueprints --region ap-south-1` lists the rest.

## 3. Give it a static IP and open the ports

A Lightsail instance's default address changes if you ever stop and start it,
which would break every invite you have handed out. A static IP is free while
it is attached to a running instance.

```console
$ aws lightsail allocate-static-ip --region ap-south-1 --static-ip-name ccledger-ip
$ aws lightsail attach-static-ip --region ap-south-1 \
    --static-ip-name ccledger-ip --instance-name ccledger

$ aws lightsail get-static-ip --region ap-south-1 --static-ip-name ccledger-ip \
    --query 'staticIp.ipAddress' --output text
13.200.0.0
```

Lightsail's firewall is separate from the OS firewall and starts with only SSH
open. Caddy needs 80 to prove control of the domain and 443 to serve:

```console
$ aws lightsail open-instance-public-ports --region ap-south-1 \
    --instance-name ccledger --port-info fromPort=80,toPort=80,protocol=TCP
$ aws lightsail open-instance-public-ports --region ap-south-1 \
    --instance-name ccledger --port-info fromPort=443,toPort=443,protocol=TCP
```

Do **not** open 4318. Nothing outside the machine should reach the ingest port
directly; Caddy is the only way in, and the setup below binds ccledger to
loopback so it cannot be reached any other way.

## 4. Point a domain at it

Create an A record for the name you want — `ccledger.example.com` — pointing at
the static IP from the previous step, and wait for it to resolve:

```console
$ dig +short ccledger.example.com
13.200.0.0
```

This has to be true **before** the next step. Caddy gets its certificate by
answering a challenge on port 80 for that name, and it cannot do that while the
name still points somewhere else.

## 5. Install

SSH in — the Lightsail console has a browser terminal, or use your own key —
and run the bootstrap script:

```console
$ curl -fsSLO https://raw.githubusercontent.com/shakibbinkabir/ccledger/main/deploy/lightsail.sh
$ sudo CCLEDGER_DOMAIN=ccledger.example.com \
       CCLEDGER_ACME_EMAIL=you@example.com \
       CCLEDGER_TIMEZONE=Asia/Dhaka \
       bash lightsail.sh
```

It installs Node, ccledger from npm, and Caddy, then runs ccledger under
systemd as its own user with the database at `/var/lib/ccledger/ccledger.db`.
Read it before running it — it is about a hundred lines and it is all `apt-get`
and one systemd unit.

Set `CCLEDGER_TIMEZONE` deliberately. It is the zone alert day and week windows
are aligned to, and changing it later moves every window boundary, which can
let a budget that has already fired this week fire again.

## 6. Check it and get the admin token

```console
$ curl -s https://ccledger.example.com/health
{"status":"ok","version":"0.1.1","uptimeSeconds":42}
```

The admin token is printed once, on the first start, which happened inside the
service. It is in the journal:

```console
$ sudo journalctl -u ccledger | grep cca_
      cca_J9ThZ049ArjrV57rxGmtk1eUPZ5AeW3k
```

Save it, then open `https://ccledger.example.com/#token=cca_…`.

If you lose it later, `sudo systemctl stop ccledger` and run `serve` once by
hand with `--rotate-admin-token`, or add the flag to the unit temporarily.
Member tokens are unaffected — nobody has to re-join.

## 7. Invite your team

```console
$ sudo -u ccledger ccledger invite "Alice Chen" --db /var/lib/ccledger/ccledger.db

Invite for Alice Chen

  endpoint    https://ccledger.example.com
  join code   BWHW-5F3V-BRXN
  expires     2026-08-27T09:14:02.118Z

Send them this line:

  npx @thisissbk/ccledger setup --code eyJ2IjoxLCJlbmRwb2ludCI6Imh0dHBzOi8v…

The code works once and expires in 24 hours.
```

No plain-HTTP warning, because the endpoint is HTTPS. What happens on their
side is in [setup.md](setup.md).

You will not want to SSH in every time you add someone. The dashboard has the
same thing under **Members → Invite a teammate**, which is the reason to save
the admin token somewhere you can find it.

## Running it

```console
$ sudo systemctl status ccledger
$ sudo journalctl -u ccledger -f
$ sudo systemctl restart ccledger
```

**Upgrading:**

```console
$ sudo npm install -g @thisissbk/ccledger@latest
$ sudo systemctl restart ccledger
```

Migrations run on boot and the database carries forward.

**Backups.** The database is the only state worth keeping. Take a snapshot with
the online backup API, which is safe while the server is running, and copy it
off the machine:

```console
$ sudo -u ccledger ccledger backup /var/lib/ccledger/backup-2026-08-26.db \
    --db /var/lib/ccledger/ccledger.db
backed up /var/lib/ccledger/ccledger.db
        to /var/lib/ccledger/backup-2026-08-26.db  (312.0 KiB)
```

Do not back it up by copying the file while the server runs. The database is in
WAL mode, so the committed state spans `ccledger.db` and `ccledger.db-wal`, and
a file copy catches the two out of step.

Lightsail's own instance snapshots work too and cost about $0.05 per GB-month,
but they are a whole-disk image; `ccledger backup` gives you one file you can
open anywhere.

## Turning it off

Deleting the instance stops the charge. The static IP is free while attached
and billed once it is not, so release it as well:

```console
$ aws lightsail delete-instance --region ap-south-1 --instance-name ccledger
$ aws lightsail release-static-ip --region ap-south-1 --static-ip-name ccledger-ip
```

Take a backup first if you want the data.

## What about Lambda, Fargate, App Runner?

Not supported, and not planned.

ccledger keeps everything in one SQLite file. That is what makes it installable
in ten minutes and backed up by copying one thing, and it is the reason the
ingest path can be idempotent with a primary key and alert debouncing can be a
transaction.

Lambda and App Runner have no persistent local disk — two concurrent
invocations get two different filesystems and there is no way to reconcile
them. Supporting them means a networked database, which means the idempotency
key, the debounce and `ccledger backup` all have to be rebuilt on something
else. For a team of two to ten that is a large amount of machinery to buy scale
nobody needs.

Fargate can work with an EBS volume and exactly one task, but SQLite over EFS
cannot: POSIX locking over NFS is unreliable, and the failure mode is a corrupt
database rather than an error. If you want a container, that is what
`docker/docker-compose.yml` and a `micro_3_1` are for.
