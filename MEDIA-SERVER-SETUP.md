# Home media server setup

A step-by-step guide to setting up your own streaming server at home. You pick a film or show in **Seerr**, it downloads automatically through a VPN, and it appears in **Jellyfin** to watch on your TV, phone or laptop.

It works on either:

- **An [Umbrel](https://umbrel.com) home server**, where apps install from the App Store, or
- **Any computer that runs Docker:** Linux, Windows, Mac or a NAS, such as an old PC that stays switched on.

The apps and settings are the same on both. Only the install part (Part 1) and a few addresses differ.

It's written so that you, or an AI assistant helping you, can follow it from top to bottom. Each step ends with a **Check** that confirms it worked before you move on.

---

## For AI assistants: read this first

You're helping someone build this on their own machine. Follow these rules:

1. **Go in order.** Don't skip ahead. Every step relies on the ones before it.
2. **Run every Check.** If a Check fails, stop and use the Troubleshooting section. Never carry on past a failed Check.
3. **Never handle secrets.** The VPN private key, passwords and API keys must be typed by the person straight into the app screens or their own `.env` file. Never ask for them in chat, and never write them into a script, commit or note. If one gets pasted into chat anyway, tell the person to create a new one once setup is done.
4. **Don't open router ports.** Nothing in this guide needs port forwarding. Outside the home, use Tailscale (Step 10).
5. **Ask before anything you can't undo**, such as uninstalling apps or deleting files or app data.
6. **Use the person's own choices.** Fill in every value in angle brackets (`<like-this>`) with what they tell you. Don't copy values from examples or from anyone else's setup.
7. **Follow only the parts for their platform.** Notes marked **Umbrel:** or **Docker:** apply only to that one.
8. If you can only give instructions and can't click for them, give one step at a time with the exact menu path, and wait for them to confirm the Check.

Ask the person for these before you start:

| Question | Used in |
|---|---|
| **Umbrel or Docker?** If Docker, which operating system: Linux, Windows, Mac or NAS? | Part 1 |
| The server's local IP address, for example `192.168.1.50` (`<server-ip>` below) | Throughout |
| Do they already have a paid Proton VPN plan (Plus or higher)? | Step 0 |
| Which country should the VPN connect through? (Optional, e.g. `United Kingdom`) | Part 1 |
| Who else in the house will watch? (One Jellyfin account per person) | Steps 6 and 7 |
| Which devices will they watch on? (TV type, phone) | Step 9 |
| Do they want anime handled separately? | Step 11 (optional) |

---

## What you're building

```
Seerr (request a film/show)
  └─> Radarr (films) / Sonarr (shows)
        ├─> Prowlarr (searches torrent sites, through the VPN)
        └─> qBittorrent inside the VPN (downloads, only ever through Proton VPN)
              └─> /downloads/movies, /downloads/shows
                    └─> Jellyfin (watch on TV / phone)
```

qBittorrent shares the VPN's network connection (via [Gluetun](https://github.com/qdm12/gluetun)). If the VPN drops, downloads stop rather than using your home connection.

## Requirements

- **A computer that stays on:** an Umbrel, or a Linux/Windows/Mac PC or NAS that can run Docker. At least 8 GB of RAM; 16 GB is more comfortable.
- Enough storage for films. One 1080p film is roughly 2–10 GB.
- **Proton VPN Plus** (or higher). The free plan doesn't allow torrenting or port forwarding. Gluetun supports other VPNs, but this guide uses Proton because it supports port forwarding, which makes downloads much faster.
- About an hour.

You're responsible for what you download. Only download content you have the right to.

## Addresses used in this guide

Apps talk to each other by name. The names differ slightly between Umbrel and Docker:

| App | Name other apps use: Umbrel | Name other apps use: Docker | Open in your browser: Umbrel | Open in your browser: Docker |
|---|---|---|---|---|
| qBittorrent / VPN | `home-qbittorrent-vpn_gluetun_1` | `gluetun` | `http://<server-ip>:8478` | `http://<server-ip>:8080` |
| Radarr | `radarr_server_1` | `radarr` | `http://<server-ip>:7878` | same |
| Sonarr | `sonarr_server_1` | `sonarr` | `http://<server-ip>:8989` | same |
| Prowlarr | `prowlarr_server_1` | `prowlarr` | `http://<server-ip>:9696` | same |
| Jellyfin | `jellyfin_server_1` | `jellyfin` | `http://<server-ip>:8096` | same |
| Seerr | (not needed) | (not needed) | `http://<server-ip>:5056` | `http://<server-ip>:5055` |

Later steps write these as **`<qbittorrent-host>`**, **`<radarr-host>`** and so on. Use the column for your platform.

---

## Step 0: Get the Proton WireGuard key

1. Sign in at [account.protonvpn.com](https://account.protonvpn.com) and go to **Downloads > WireGuard configuration**.
2. Platform: **Router** (or GNU/Linux).
3. Turn **NAT-PMP (Port Forwarding)** on. Without it, downloads will be very slow.
4. Choose any server marked **P2P** and select **Create**.
5. Keep the config window open. The person needs the value after `PrivateKey =` in Part 1. *(AI: don't ask for it to be pasted into chat.)*

---

# Part 1: Install the apps

Do **either 1A (Umbrel)** or **1B (Docker)**, then carry on at Part 2.

## 1A. Umbrel

### Install the main apps

In the Umbrel **App Store**, install these one at a time, waiting for each to finish:

1. **Jellyfin**
2. **Radarr**
3. **Sonarr**
4. **Prowlarr**
5. **Seerr**

Radarr, Sonarr and Prowlarr will also install **Transmission**, which they need. Leave Transmission installed: Umbrel requires it. You'll stop it in Step 4.

Umbrel connects these apps to each other automatically: Prowlarr gets linked to Radarr and Sonarr, and the folders `/downloads/movies` and `/downloads/shows` are created.

### Add this app store and install qBittorrent VPN

1. Umbrel **App Store** > **⋯** (top right) > **Community App Stores**. Paste `https://github.com/kx-viii/umbrel-app-store` and select **Add**.
2. Open the store called **Home Apps** and install **qBittorrent VPN**.
3. Right-click the app's icon > **Settings** > **Advanced** > **Custom variables**. Pick the service **`gluetun`** and add:
   - `WIREGUARD_PRIVATE_KEY` = the `PrivateKey` value from Step 0.
   - Optional: `SERVER_COUNTRIES` = a country name, for example `United Kingdom`.
4. **Save**. The app restarts and connects. Until the key is added, it deliberately blocks all internet traffic.
5. Open qBittorrent VPN and log in with `admin` / `adminadmin`. Change the password under **Tools > Options > WebUI** and save.

The app already has the right settings for Umbrel: it saves to `/downloads`, and Radarr and Sonarr can connect without a password.

**Check:** Jellyfin, Radarr, Sonarr, Prowlarr, Seerr, Transmission and qBittorrent VPN all appear on the home screen and open without errors.

## 1B. Docker (Linux, Windows, Mac or NAS)

### Install Docker

- **Linux:** install Docker Engine with the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)), then run the commands below as your normal user (add yourself to the `docker` group, or put `sudo` in front).
- **Windows or Mac:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/), open it and leave it running. In its settings, turn on **Start Docker Desktop when you sign in**.
- **NAS** (Synology, QNAP, Unraid and so on): use its Docker / Container Manager app, which can take a Compose file ("project").

Also set the computer to **never sleep**, otherwise downloads and streaming stop.

**Check:** `docker compose version` prints a version number.

### Create the files

1. Make a folder called `media-server` somewhere with plenty of free space. All films and shows will be stored inside it.
2. Inside it, create the download folders: `data/movies` and `data/shows`.
   - Linux: `mkdir -p media-server/data/movies media-server/data/shows`, run as your normal user, not root.
3. Inside `media-server`, create a file called **`.env`** with this content. The **person** fills in the key themselves:

   ```ini
   # Private settings. Never share or upload this file.
   WIREGUARD_PRIVATE_KEY=
   # Optional: a country for the VPN, e.g. United Kingdom
   SERVER_COUNTRIES=
   # Your time zone, from https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
   TZ=Europe/London
   # Linux only: the numbers from running `id -u` and `id -g`. Leave as 1000 on Windows/Mac.
   PUID=1000
   PGID=1000
   # Where films and shows are stored
   DATA_DIR=./data
   ```

4. Inside `media-server`, create **`docker-compose.yml`** with exactly this content:

   ```yaml
   services:
     # VPN connection. qBittorrent uses its network, so it can only reach the internet through Proton.
     gluetun:
       image: qmcgaw/gluetun:v3.41.3
       container_name: gluetun
       cap_add:
         - NET_ADMIN
       devices:
         - /dev/net/tun:/dev/net/tun
       environment:
         - VPN_SERVICE_PROVIDER=protonvpn
         - VPN_TYPE=wireguard
         - WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY}
         - SERVER_COUNTRIES=${SERVER_COUNTRIES:-}
         - PORT_FORWARD_ONLY=on
         - VPN_PORT_FORWARDING=on
         # Gives qBittorrent the port Proton forwards, so downloads are fast
         - VPN_PORT_FORWARDING_UP_COMMAND=/bin/sh -c 'wget -O- -nv --retry-connrefused --post-data "json={\"listen_port\":{{PORT}},\"current_network_interface\":\"{{VPN_INTERFACE}}\",\"random_port\":false,\"upnp\":false}" http://127.0.0.1:8080/api/v2/app/setPreferences'
         - VPN_PORT_FORWARDING_DOWN_COMMAND=/bin/sh -c 'wget -O- -nv --retry-connrefused --post-data "json={\"listen_port\":0,\"current_network_interface\":\"lo\"}" http://127.0.0.1:8080/api/v2/app/setPreferences'
         # Proxy on port 8888 so Prowlarr's searches also go through the VPN
         - HTTPPROXY=on
         - FIREWALL_INPUT_PORTS=8080,8888
         - TZ=${TZ}
       ports:
         - 8080:8080 # qBittorrent web page
       volumes:
         - gluetun:/gluetun
       restart: unless-stopped

     qbittorrent:
       image: ghcr.io/hotio/qbittorrent:release-5.2.3
       container_name: qbittorrent
       network_mode: service:gluetun
       depends_on:
         - gluetun
       environment:
         - PUID=${PUID}
         - PGID=${PGID}
         - UMASK=002
         - TZ=${TZ}
       volumes:
         - qbittorrent:/config
         - ${DATA_DIR}:/downloads
       restart: unless-stopped

     prowlarr:
       image: linuxserver/prowlarr:version-2.6.5.5623
       container_name: prowlarr
       environment:
         - PUID=${PUID}
         - PGID=${PGID}
         - TZ=${TZ}
       ports:
         - 9696:9696
       volumes:
         - prowlarr:/config
       restart: unless-stopped

     radarr:
       image: linuxserver/radarr:6.4.4
       container_name: radarr
       environment:
         - PUID=${PUID}
         - PGID=${PGID}
         - TZ=${TZ}
       ports:
         - 7878:7878
       volumes:
         - radarr:/config
         - ${DATA_DIR}:/downloads
       restart: unless-stopped

     sonarr:
       image: linuxserver/sonarr:4.0.20
       container_name: sonarr
       environment:
         - PUID=${PUID}
         - PGID=${PGID}
         - TZ=${TZ}
       ports:
         - 8989:8989
       volumes:
         - sonarr:/config
         - ${DATA_DIR}:/downloads
       restart: unless-stopped

     jellyfin:
       image: linuxserver/jellyfin:version-12.2ubu2604
       container_name: jellyfin
       environment:
         - PUID=${PUID}
         - PGID=${PGID}
         - TZ=${TZ}
       ports:
         - 8096:8096
         - 7359:7359/udp # lets apps find the server on your network
       volumes:
         - jellyfin:/config
         - ${DATA_DIR}:/downloads
       restart: unless-stopped

     seerr:
       image: ghcr.io/seerr-team/seerr:v3.5.0
       container_name: seerr
       init: true
       environment:
         - TZ=${TZ}
       ports:
         - 5055:5055
       volumes:
         - seerr:/app/config
       restart: unless-stopped

   # App settings are kept in Docker volumes, so they survive restarts and updates
   volumes:
     gluetun:
     qbittorrent:
     prowlarr:
     radarr:
     sonarr:
     jellyfin:
     seerr:
   ```

Every app sees the same storage folder as `/downloads`. That lets Radarr and Sonarr move finished downloads into the library instantly, without copying.

### Start it

In a terminal, inside the `media-server` folder, run:

```sh
docker compose up -d
```

The first run downloads the apps, which takes a few minutes. Then run `docker compose ps`.

**Check:** all seven containers show as `running` (or `Up`). Run `docker logs gluetun` and look for a line saying the VPN is connected and showing a **public IP that isn't your home IP**, and a line with the **port forwarded**.

### First logins

1. **qBittorrent:**
   1. Run `docker logs qbittorrent` and find the **temporary password** it printed.
   2. Open `http://<server-ip>:8080` and log in as `admin` with that password.
   3. Under **Tools > Options > WebUI**, set a new password, and tick **Bypass authentication for clients on localhost**. The VPN needs that to give qBittorrent its port.
   4. Under **Tools > Options > Downloads**, set **Default Save Path** to `/downloads`.
   5. Save.
2. **Radarr, Sonarr and Prowlarr:** when you first open each one, it asks you to set up a login. Choose **Forms (Login Page)**, set **Authentication Required** to **Enabled**, and choose a username and password.

**Check:** you can log in to qBittorrent, Radarr, Sonarr and Prowlarr.

---

# Part 2: Connect everything (both platforms)

## Step 1: Block fake downloads

Some torrents for new episodes are fake and actually contain a virus, usually a `.exe` file. In qBittorrent go to **Tools > Options > Downloads**, tick **Excluded file names** and paste this list, one per line:

```
*.exe
*.scr
*.bat
*.cmd
*.com
*.pif
*.msi
*.lnk
*.vbs
*.js
*.jse
*.wsf
*.ps1
*.hta
*.apk
*.zipx
```

Save.

## Step 2: Check the VPN

1. In qBittorrent, **Tools > Options > Connection**: the **listening port** should be a random-looking number assigned by Proton, **not 6881**. It can take a minute after starting.
2. Go to [ipleak.net](https://ipleak.net), find **Torrent Address detection** and add the magnet link it gives you to qBittorrent. After a minute, ipleak should show a **Proton VPN IP, not your home IP**. Then delete that torrent.

**Check:** both of the above pass. If either fails, stop and see Troubleshooting.

## Step 3: Set up Prowlarr (searching)

### Send searches through the VPN

In **Prowlarr > Settings > General > Proxy** (select **Show Advanced** if it's hidden):

| Setting | Value |
|---|---|
| Use Proxy | On |
| Proxy Type | HTTP(S) |
| Hostname | `<qbittorrent-host>` |
| Port | `8888` |
| Username / Password | leave empty |
| Addresses for the proxy to ignore | Umbrel: `radarr_server_1,sonarr_server_1,prowlarr_indexer_proxy_1,home-qbittorrent-vpn_gluetun_1`. Docker: `radarr,sonarr,gluetun` |
| Bypass Proxy for Local Addresses | On |

Save.

### Link Prowlarr to Radarr and Sonarr

- **Umbrel:** already done. **Settings > Apps** lists Radarr and Sonarr.
- **Docker:** under **Settings > Apps > +**, add **Radarr**:
  - Prowlarr Server `http://prowlarr:9696`
  - Radarr Server `http://radarr:7878`
  - API Key: from **Radarr > Settings > General**

  Then **Test** and **Save**. Do the same for **Sonarr** (`http://sonarr:8989`, API key from **Sonarr > Settings > General**).

### Add search sites (indexers)

**Prowlarr > Indexers > Add Indexer**: search for the sites you want, add them, and use **Test** on each one.

- **Knaben** is a good start: it searches several public sites at once.
- Sites behind a Cloudflare "are you human" check often fail. If a site keeps failing its Test, delete it.

Then in **Settings > Apps** select **Sync App Indexers** (the sync icon).

**Check:** in **Prowlarr > Search**, search for a well-known film and get results. Then in **Radarr > Settings > Indexers**, the Prowlarr indexers are listed (the same goes for Sonarr).

## Step 4: Point Radarr and Sonarr at qBittorrent

Do this in **Radarr**, then again in **Sonarr**:

1. **Settings > Download Clients > +** > **qBittorrent**.
2. Fill in:
   - Name: `qBittorrent VPN`
   - Host: `<qbittorrent-host>`
   - Port: `8080`
   - Username and password:
     - **Umbrel:** leave empty. The app trusts other Umbrel apps.
     - **Docker:** `admin` and the qBittorrent password you set.
   - **Remove Completed: On** (tidies up finished torrents; your copy in the library stays).
3. **Test**, then **Save**.
4. **Umbrel:** delete the **Transmission** download client from the same list.
5. **Settings > Media Management > Root Folders**: Radarr needs `/downloads/movies` and Sonarr needs `/downloads/shows`. Umbrel adds these for you. On **Docker**, select **Add Root Folder** and add them.

**Umbrel:** then stop Transmission to save memory: right-click the **Transmission** app icon > **Stop**. Don't uninstall it.

**Check:** the qBittorrent VPN client shows as enabled with a green Test in both Radarr and Sonarr, and the root folders are listed.

## Step 5: Optional: stop seeding when finished

By default qBittorrent keeps uploading (seeding) after a download finishes. To stop as soon as a download is done, go to qBittorrent **Tools > Options > BitTorrent > Seeding Limits**, tick **When seeding time reaches** `0` minutes, choose action **Stop torrent**, and save. Leave this off if you'd rather keep seeding.

## Step 6: Set up Jellyfin

1. Open **Jellyfin** and follow the setup wizard:
   - Create the **admin account** with a strong password.
   - Add a library: type **Movies**, folder `/downloads/movies`.
   - Add a library: type **Shows**, folder `/downloads/shows`.
   - Pick your language and country for metadata, then finish.
2. Create one account for each other person in the house: **Dashboard > Users > +**. Don't make them admins.
3. Optional, for a graphics card: **Dashboard > Playback > Transcoding**. This only matters when streaming away from home or at lower quality; on the home network most things play directly.
   - **Umbrel:** choose **NVIDIA NVENC** for an Nvidia GTX 16-series or newer card (umbrelOS 2.0 detects these automatically; check under **Settings > Device info**), or **Intel QuickSync (QSV)** for an Intel processor's built-in graphics.
   - **Docker:** the container also needs access to the graphics card. Follow [Jellyfin's hardware acceleration guide](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/) for your card.

**Check:** you can log in to Jellyfin and see the two empty libraries.

## Step 7: Set up Seerr (where you request things)

1. Open **Seerr** and pick **Jellyfin** as the media server.
2. Server address: hostname `<jellyfin-host>`, port `8096`, no SSL. Sign in with your **Jellyfin admin** account.
3. **Sync libraries**, tick **Movies** and **Shows**, and continue.
4. Add **Radarr**:
   - Default server: on
   - Hostname `<radarr-host>`, port `7878`, no SSL
   - API key: copy it from **Radarr > Settings > General > API Key** (the person pastes it in directly)
   - **Test**, then choose quality profile (e.g. `HD-1080p`), root folder `/downloads/movies` and minimum availability **Released**. Save.
5. Add **Sonarr** the same way: hostname `<sonarr-host>`, port `8989`, API key from **Sonarr > Settings > General**, quality profile, root folder `/downloads/shows`. Save.
6. Finish the setup.

### Let the rest of the house use it

1. **Seerr > Users > Import Jellyfin Users**, then tick everyone.
2. **Settings > Users > Default Permissions**: tick **Request** and **Auto-Approve**, so requests start straight away.
3. **Umbrel:** Seerr is also behind the Umbrel login. If other people should sign in with their own Jellyfin account, turn the **Umbrel login off for the Seerr app** in its settings on Umbrel. Seerr has its own login. Leave it on if you're the only one who'll use it.

**Check:** a non-admin Jellyfin account can sign in to Seerr.

## Step 8: Do a full test

1. In Seerr, search for **Night of the Living Dead (1968)**. It's in the public domain, so it's safe to test with. Select **Request**.
2. In **Radarr > Activity > Queue**, it should appear within a few minutes and start downloading.
3. When it finishes, it moves into `/downloads/movies` and shows up in Jellyfin. If it doesn't appear after a few minutes, run **Dashboard > Scan All Libraries** in Jellyfin.
4. Play it in Jellyfin.

**Check:** the film plays in Jellyfin. The whole system now works.

## Step 9: Watch on your TV and phone

- **TVs and streaming sticks:** install the **Jellyfin** app (on Fire TV, Android TV, Samsung, LG, Apple TV, Roku and others). If the server isn't found automatically, enter `http://<server-ip>:8096` by hand. Give the server a fixed IP on your router so this address never changes.
- **Phones and laptops at home:** the Jellyfin app, or a browser at `http://<server-ip>:8096`.
- Optional: Android TV and Fire TV apps such as **Wholphin**, and the **Moonfin** app on Samsung TVs, add Seerr requests on the TV itself. They're more work to install.

## Step 10: Watch away from home (safely)

Don't forward ports on your router. Use **Tailscale** instead. It's free for personal use.

1. Install Tailscale on the server and sign in:
   - **Umbrel:** install **Tailscale** from the App Store.
   - **Docker:** install it on the computer itself from [tailscale.com/download](https://tailscale.com/download).
2. Install Tailscale on your phone or laptop and sign in with the same account.
3. In Jellyfin, use the server's Tailscale address: `http://<server-tailscale-ip>:8096`. You'll find it in the Tailscale app.

Only devices signed in to your Tailscale account can reach the server.

## Step 11: Optional: separate anime

Anime is better searched on a dedicated site (**Nyaa**), with its own folders.

1. Create the folders `anime` and `anime-movies` next to `movies` and `shows`. On Umbrel, use **Files** > Downloads; on Docker, put them in your `data` folder.
2. In **Prowlarr**, add the **Nyaa.si** indexer (category: Anime - English-translated).
3. In **Sonarr > Settings > Tags** and **Radarr > Settings > Tags**, create the tags `regular` and `anime`.
4. In Prowlarr, tag Nyaa `anime` and every other indexer `regular`, then sync to the apps. Each film or show only uses indexers with a matching tag, so **every item needs one of these tags or it won't find anything**.
5. Add `/downloads/anime` as a root folder in Sonarr and `/downloads/anime-movies` in Radarr.
6. In **Seerr > Settings > Services**, edit Sonarr: set the anime root folder to `/downloads/anime`, anime tag `anime` and default tag `regular`. Edit Radarr: default tag `regular`.
7. In Seerr, add an **override rule** for Radarr: when TMDB keyword is **anime** (210024), use root folder `/downloads/anime-movies` and tag `anime`.
8. In Jellyfin, add a library of type **Mixed movies and shows** called "Anime", with both anime folders.

Chinese animation (donghua) often lacks TMDB's anime keyword and may need moving to the anime settings by hand in Sonarr.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| qBittorrent's listening port is still 6881 | The VPN hasn't connected or port forwarding is off. Make sure the key came from a config with **NAT-PMP** on, then restart. Some Proton servers time out; Gluetun keeps trying others, so give it a few minutes. If it still fails, set `SERVER_COUNTRIES` to another country. **Docker:** also check **Bypass authentication for clients on localhost** is ticked in qBittorrent. |
| ipleak shows your home IP | **Stop qBittorrent straight away** and check the VPN key and settings. It shouldn't be possible with this setup, so don't use it until it's fixed. |
| **Docker:** `gluetun` keeps restarting | Run `docker logs gluetun`. Usually the key in `.env` is missing or wrong (no spaces or quotes around it). On a NAS, `/dev/net/tun` may need enabling; see the [Gluetun wiki](https://github.com/qdm12/gluetun-wiki). |
| **Docker:** qBittorrent page won't load after the VPN restarted | Run `docker compose restart qbittorrent`. It needs restarting whenever Gluetun restarts. |
| **Docker:** "Permission denied" or "folder not writable" in Radarr/Sonarr | On Linux, `PUID`/`PGID` in `.env` must match the owner of the `data` folder (`id -u`, `id -g`). Fix the values, then run `docker compose up -d`. |
| **Umbrel:** qBittorrent says "Unauthorized" | Restart the app once. The first start configures it for Umbrel. |
| Searches fail in Prowlarr | The VPN may be down: when the VPN is down, the proxy refuses requests on purpose. Check the VPN is running. Also try another indexer. |
| A download sits in the queue saying "No files found are eligible" | It was a fake release with only a `.exe` inside, blocked by Step 1. In Radarr/Sonarr **Activity > Queue**, remove it with **Blocklist release** ticked. This usually happens with episodes that haven't aired yet. |
| Requested item never downloads | Check it has a quality profile and (if you did Step 11) a `regular`/`anime` tag. Then in Radarr/Sonarr open the item and select **Interactive Search** to see why releases were rejected. |
| Jellyfin doesn't show new files | Run **Dashboard > Scan All Libraries**, and check the library folders are `/downloads/movies` and `/downloads/shows`. |
| TV app can't find the server | Enter `http://<server-ip>:8096` by hand. |
| Server getting slow | Stop apps you don't use (on Umbrel, Transmission should already be stopped). 8 GB of RAM is tight with many apps. |

## Updating

- **Umbrel:** update apps from the App Store as normal. Your settings and VPN key are kept.
- **Docker:** the versions in `docker-compose.yml` are fixed so everything keeps working together. To update an app, change its version tag to a newer release from its page on Docker Hub or GitHub, then run `docker compose up -d`. Settings are kept in the Docker volumes.

## Keeping it safe

- Your Proton key lives only in the Umbrel app settings, or in your `.env` file on Docker. Never share or upload `.env`.
- Don't forward ports on your router. Use Tailscale for access away from home.
- Use strong passwords for Umbrel, Jellyfin, qBittorrent, Radarr, Sonarr and Prowlarr.
- One Jellyfin account per person, and only you as admin.
- If an API key or password was ever pasted into a chat or a message, change it: for the Radarr/Sonarr/Prowlarr API keys, use **Settings > General > API Key > regenerate**, then update the key in Seerr (and in Prowlarr on Docker).
