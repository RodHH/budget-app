# Put the budget app on Oracle Cloud (Always Free)

You do the clicking in Oracle's console. A setup script does everything on the server: it installs Node and Caddy, sets up free automatic HTTPS, the app, a background service and the firewall. Plan on about 20 minutes, most of it waiting.

**Cost:** $0 if you stay on the Always Free shapes below. Oracle asks for a credit card to verify you, but Always Free resources aren't charged. Don't click **Upgrade to Pay As You Go** unless you decide to (see "Idle reclaim" below).

## Before you start: get the code into a GitHub repository

The server downloads the app from GitHub at `RodHH/budget-app`, which `REPO_URL` in the script already points at. The repo is public, so leave `GITHUB_TOKEN` blank.

## 1. Create your Oracle account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Pick a **home region** close to you (for example US East (Ashburn) or US West (Phoenix)). It can't be changed later, and the free servers must live there.
3. Finish the identity and card verification.

## 2. Fill in the setup script

Copy the whole setup script. It's in your GitHub repo under **scripts → oracle-cloud-init.sh** (use **Copy raw file**), and attached in our Claude thread. You'll paste it into Oracle in step 3 and fill in the block at the top right there in Oracle's box:

| Setting | What to put |
|---|---|
| `REPO_URL` | Your repository's address. It's already filled in if we used `RodHH/budget-app`. |
| `GITHUB_TOKEN` | Leave blank (the repo is public). Only needed if the repo is private: see step 6. |
| `SETUP_CODE` | Any 8+ characters you make up. You type it once to create your login. |
| `NOTIFY_EMAIL` | Your email address. Apple requires one for push, and it's also used for the HTTPS certificate. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | Your Plaid **Sandbox** keys from <https://dashboard.plaid.com/developers/keys>. You can leave these blank and add them later. |

These values go only into Oracle's form and onto your server. Don't paste them into chat.

## 3. Create the server

In the Oracle console: **☰ → Compute → Instances → Create instance**.

1. **Name:** `budget`.
2. **Image and shape → Edit**:
   - **Image:** Canonical Ubuntu 24.04.
   - **Shape:** Ampere → **VM.Standard.A1.Flex**, 1 OCPU, 6 GB memory. It's labeled "Always Free-eligible".
   - If you see "Out of capacity" (common), use **VM.Standard.E2.1.Micro** (AMD) instead. It's also Always Free and is enough for this app.
3. **Networking:** keep "Create new virtual cloud network" and "public subnet", and make sure **Assign a public IPv4 address** is on.
4. **Add SSH keys:** choose **Generate a key pair for me** and **Save private key**. Keep that file; you need it later to change settings.
5. **Show advanced options → Management → Initialization script → Paste cloud-init script**, then paste the whole filled-in script.
6. Click **Create**.

## 4. Open the web ports

Oracle blocks web traffic until you allow it.

1. On the instance page, under **Primary VNIC**, click the **Subnet** link.
2. Open **Security** (older consoles: **Security Lists**), then **Default Security List**.
3. Click **Add Ingress Rules**:
   - **Source CIDR:** `0.0.0.0/0`
   - **IP Protocol:** TCP
   - **Destination Port Range:** `80,443`
4. Save.

The script already opens the same ports in the server's own firewall.

## 5. Open your app

1. Copy the instance's **Public IP address**, for example `129.146.10.20`.
2. Replace the dots with dashes and add `.sslip.io` in front of `https://`: `https://129-146-10-20.sslip.io`. That's your app's address. (sslip.io is a free service that turns an IP address into a web name, so you don't need to buy a domain.)
3. Wait about 10 minutes after creating the instance, then open that address in Safari on your iPhone.
4. Enter your `SETUP_CODE`, choose a username and password, and you're in.
5. Install it on your iPhone and turn on notifications. The steps are in SETUP.md, sections 4 and 5.

If the page doesn't load after 15 minutes:
- Check that the ingress rule from step 4 was saved.
- Look at the setup log: on the instance page click **Cloud Shell**, then run the SSH command below followed by `sudo tail -50 /var/log/budget-setup.log`.

## 6. If your repository is private: make a read-only token

1. Go to GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**.
2. **Repository access:** only the budget repo.
3. **Permissions:** Contents → **Read-only**.
4. Put the token in `GITHUB_TOKEN` in the script. The script uses it once to download the code and doesn't keep it in git settings.

## Changing settings later (for example, switching Plaid to real banks)

1. In the Oracle console, click the **Cloud Shell** icon (top right).
2. Upload your private key with Cloud Shell's menu → **Upload**.
3. Connect to the server:
   ```sh
   chmod 600 ssh-key-*.key
   ssh -i ssh-key-*.key ubuntu@YOUR.PUBLIC.IP
   ```
4. Change settings with the helper. It saves them and restarts the app:
   ```sh
   sudo budget-config PLAID_ENV=production PLAID_SECRET=your-production-secret
   ```
   Running `sudo budget-config` on its own shows the current non-secret settings.
5. For real banks, also add `https://<your-address>/oauth-return` in the Plaid Dashboard under **Developers → API → Allowed redirect URIs**. The script already set the app's side.
6. To install a newer version of the app after we change the code: `sudo budget-update`.

## Idle reclaim: the one Always Free catch

Oracle's Always Free rules say it may reclaim an instance that is idle for 7 days. Idle means the 95th-percentile CPU and network use stay below 20%; on Arm (A1) servers, memory use below 20% also counts. A personal budget app is idle almost all the time, so this can happen. Oracle's page doesn't say whether upgrading to Pay As You Go exempts you.

What I recommend:
- Download a backup now and then (**More → Backup, export & sample data → Download backup**). The app also keeps 14 daily copies on the server, but those disappear if the server is reclaimed.
- If Oracle reclaims it, create a new instance with the same script and restore your backup. Bank connections need to be linked again.
- Upgrading to Pay As You Go keeps Always Free resources free, but anything you create beyond the free limits is billed to your card. Only do it if you're comfortable watching for that.
