# Media server setup on Umbrel

A step-by-step guide to setting up your own streaming server on an [Umbrel](https://umbrel.com) home server. You pick a film or show in **Seerr**, it downloads automatically through a VPN, and it appears in **Jellyfin** to watch on your TV, phone or laptop.

It's written so that you, or an AI assistant helping you, can follow it from top to bottom. Each step ends with a **Check** that confirms it worked before you move on.

---

## For AI assistants: read this first

You're helping someone build this on their own Umbrel. Follow these rules:

1. **Go in order.** Don't skip ahead. Every step relies on the ones before it.
2. **Run every Check.** If a Check fails, stop and use the Troubleshooting section. Never carry on past a failed Check.
3. **Never handle secrets.** The VPN private key, passwords and API keys must be typed by the person straight into the Umbrel or app screens. Never ask for them in chat, and never write them into a file, script, commit or note. If one gets pasted into chat anyway, tell the person to create a new one once setup is done.
4. **Don't open router ports.** Nothing in this guide needs port forwarding. Outside the home, use Tailscale (Step 10).
5. **Ask before anything you can't undo**, such as uninstalling apps or deleting files or app data.
6. **Use the person's own choices.** Fill in every value in angle brackets (`<like-this>`) with what they tell you. Don't copy values from examples or from anyone else's setup.
7. If you can only give instructions and can't click for them, give one step at a time with the exact menu path, and wait for them to confirm the Check.

Ask the person for these before you start:

| Question | Used in |
|---|---|
| Their Umbrel's local address, for example `http://umbrel.local` or `http://<umbrel-ip>` | Throughout |
| Do they already have a paid Proton VPN plan (Plus or higher)? | Step 2 |
| Which country should the VPN connect through? (Optional, e.g. `United Kingdom`) | Step 2 |
| Who else in the house will watch? (One Jellyfin account per person) | Steps 7 and 8 |
| Which devices will they watch on? (TV type, phone) | Step 9 |
| Do they want anime handled separately? | Step 11 (optional) |

---

## What you're building

```
Seerr (request a film/show)
  └─> Radarr (films) / Sonarr (shows)
        ├─> Prowlarr (searches torrent sites, through the VPN)
        └─> qBittorrent VPN (downloads, only ever through Proton VPN)
              └─> /downloads/movies, /downloads/shows
                    └─> Jellyfin (watch on TV / phone)
```

All of these apps run on the Umbrel. qBittorrent is built into the VPN, so if the VPN drops, downloads stop rather than using your home connection.

## Requirements

- An Umbrel running umbrelOS 1.x or 2.x, with enough storage space for films (one 1080p film is roughly 2–10 GB).
- At least 8 GB of RAM. 16 GB is more comfortable if you'll run other apps too.
- **Proton VPN Plus** (or higher). The free plan doesn't allow torrenting or port forwarding.
- About an hour.

You're responsible for what you download. Only download content you have the right to.

---

## Step 1: Install the main apps

In the Umbrel **App Store**, install these one at a time, waiting for each to finish:

1. **Jellyfin**
2. **Radarr**
3. **Sonarr**
4. **Prowlarr**
5. **Seerr**

Radarr, Sonarr and Prowlarr will also install **Transmission**, which they need. Leave Transmission installed: Umbrel requires it. You'll stop it in Step 4.

Umbrel connects these apps to each other automatically: Prowlarr gets linked to Radarr and Sonarr, and the download folders `/downloads/movies` and `/downloads/shows` are created.

**Check:** all six apps (including Transmission) appear on the Umbrel home screen and open without errors.

## Step 2: Install qBittorrent VPN

### 2a. Get the Proton WireGuard key

1. Sign in at [account.protonvpn.com](https://account.protonvpn.com) and go to **Downloads > WireGuard configuration**.
2. Platform: **Router** (or GNU/Linux).
3. Turn **NAT-PMP (Port Forwarding)** on. Without it, downloads will be very slow.
4. Choose any server marked **P2P** and select **Create**.
5. Keep the config window open. The person needs the value after `PrivateKey =` in 2c. *(AI: don't ask for it to be pasted into chat.)*

### 2b. Add this app store

1. Umbrel **App Store** > **⋯** (top right) > **Community App Stores**.
2. Paste this repository's GitHub URL and select **Add**.
3. Open the store called **Home Apps**.

### 2c. Install and add the key

1. In Home Apps, install **qBittorrent VPN**.
2. Right-click the app's icon > **Settings** > **Advanced** > **Custom variables**. Pick the service **`gluetun`** and add:
   - `WIREGUARD_PRIVATE_KEY` = the `PrivateKey` value from 2a.
   - Optional: `SERVER_COUNTRIES` = a country name, for example `United Kingdom`.
3. **Save**. The app restarts and connects. Until the key is added, it deliberately blocks all internet traffic.

### 2d. Set a password

Open qBittorrent VPN and log in with `admin` / `adminadmin`. Change the password under **Tools > Options > WebUI** and save.

### 2e. Block fake downloads

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

**Check (VPN works):**
1. In qBittorrent, **Tools > Options > Connection**: the **listening port** should be a random-looking number assigned by Proton, **not 6881**. It can take a minute after starting.
2. Go to [ipleak.net](https://ipleak.net), find **Torrent Address detection** and add the magnet link it gives you to qBittorrent. After a minute, ipleak should show a **Proton VPN IP, not your home IP**. Then delete that torrent.

If either check fails, stop and see Troubleshooting.

## Step 3: Send Prowlarr's searches through the VPN

The VPN app also runs a proxy, so Prowlarr's searches go through Proton too.

In **Prowlarr > Settings > General > Proxy** (select **Show Advanced** if it's hidden):

| Setting | Value |
|---|---|
| Use Proxy | On |
| Proxy Type | HTTP(S) |
| Hostname | `home-qbittorrent-vpn_gluetun_1` |
| Port | `8888` |
| Username / Password | leave empty |
| Addresses for the proxy to ignore | `radarr_server_1,sonarr_server_1,prowlarr_indexer_proxy_1,home-qbittorrent-vpn_gluetun_1` |
| Bypass Proxy for Local Addresses | On |

Save.

### Add search sites (indexers)

**Prowlarr > Indexers > Add Indexer**: search for the sites you want, add them, and use **Test** on each one.

- **Knaben** is a good start: it searches several public sites at once.
- Sites behind a Cloudflare "are you human" check often fail, even with the FlareSolverr helper that comes with Prowlarr. If a site keeps failing its Test, delete it.

Then **Settings > Apps** should already list **Radarr** and **Sonarr**. Select **Sync App Indexers** (the sync icon).

**Check:** in **Prowlarr > Search**, search for a well-known film and get results. Then in **Radarr > Settings > Indexers**, the Prowlarr indexers are listed (the same goes for Sonarr).

## Step 4: Point Radarr and Sonarr at qBittorrent VPN

Do this in **Radarr**, then again in **Sonarr**:

1. **Settings > Download Clients > +** > **qBittorrent**.
2. Fill in:
   - Name: `qBittorrent VPN`
   - Host: `home-qbittorrent-vpn_gluetun_1`
   - Port: `8080`
   - Username and password: **leave empty**. The app trusts other Umbrel apps.
   - **Remove Completed: On** (tidies up finished torrents; your copy in the library stays).
3. **Test**, then **Save**.
4. Delete the **Transmission** download client from the same list.
5. While you're here, check **Settings > Media Management > Root Folders**: Radarr should show `/downloads/movies` and Sonarr `/downloads/shows`.

Then stop Transmission to save memory: right-click the **Transmission** app icon > **Stop**. Don't uninstall it.

**Check:** the qBittorrent VPN client shows as enabled, with a green Test, in both Radarr and Sonarr, and Transmission is gone from both lists.

## Step 5: Optional: stop seeding when finished

By default qBittorrent keeps uploading (seeding) after a download finishes. To stop as soon as a download is done, go to qBittorrent **Tools > Options > BitTorrent > Seeding Limits**, tick **When seeding time reaches** `0` minutes, choose action **Stop torrent**, and save. Leave this off if you'd rather keep seeding.

## Step 6: Set up Jellyfin

1. Open **Jellyfin** and follow the setup wizard:
   - Create the **admin account** with a strong password.
   - Add a library: type **Movies**, folder `/downloads/movies`.
   - Add a library: type **Shows**, folder `/downloads/shows`.
   - Pick your language and country for metadata, then finish.
2. Create one account for each other person in the house: **Dashboard > Users > +**. Don't make them admins.
3. Optional, for a graphics card: **Dashboard > Playback > Transcoding**. Choose **NVIDIA NVENC** for an Nvidia GTX 16-series or newer card (umbrelOS 2.0 detects these automatically; check under **Settings > Device info**), or **Intel QuickSync (QSV)** for an Intel processor's built-in graphics. Save. This only matters when streaming away from home or at lower quality; on the home network most things play directly.

**Check:** you can log in to Jellyfin and see the two empty libraries.

## Step 7: Set up Seerr (where you request things)

1. Open **Seerr** and pick **Jellyfin** as the media server.
2. Server address: hostname `jellyfin_server_1`, port `8096`, no SSL. Sign in with your **Jellyfin admin** account.
3. **Sync libraries**, tick **Movies** and **Shows**, and continue.
4. Add **Radarr**:
   - Default server: on
   - Hostname `radarr_server_1`, port `7878`, no SSL
   - API key: copy it from **Radarr > Settings > General > API Key** (the person pastes it in directly)
   - **Test**, then choose quality profile (e.g. `HD-1080p`), root folder `/downloads/movies` and minimum availability **Released**. Save.
5. Add **Sonarr** the same way: hostname `sonarr_server_1`, port `8989`, API key from **Sonarr > Settings > General**, quality profile, root folder `/downloads/shows`. Save.
6. Finish the setup.

### Let the rest of the house use it

1. **Seerr > Users > Import Jellyfin Users**, then tick everyone.
2. **Settings > Users > Default Permissions**: tick **Request** and **Auto-Approve**, so requests start straight away.
3. Seerr has its own login. If other people should sign in with their own Jellyfin account, turn the **Umbrel login off for the Seerr app** in its settings on Umbrel. Leave it on if you're the only one who'll use it.

**Check:** a non-admin Jellyfin account can sign in to Seerr.

## Step 8: Do a full test

1. In Seerr, search for **Night of the Living Dead (1968)**. It's in the public domain, so it's safe to test with. Select **Request**.
2. In **Radarr > Activity > Queue**, it should appear within a few minutes and start downloading.
3. When it finishes, it moves into `/downloads/movies` and shows up in Jellyfin. If it doesn't appear after a few minutes, run **Dashboard > Scan All Libraries** in Jellyfin.
4. Play it in Jellyfin.

**Check:** the film plays in Jellyfin. The whole system now works.

## Step 9: Watch on your TV and phone

- **TVs and streaming sticks:** install the **Jellyfin** app (on Fire TV, Android TV, Samsung, LG, Apple TV, Roku and others). Jellyfin may not appear automatically, so enter the server address by hand: `http://<umbrel-ip>:8096`. Give the Umbrel a fixed IP on your router so this address never changes.
- **Phones and laptops at home:** the Jellyfin app, or a browser at `http://<umbrel-ip>:8096`.
- Optional: Android TV and Fire TV apps such as **Wholphin**, and the **Moonfin** app on Samsung TVs, add Seerr requests on the TV itself. They're more work to install.

## Step 10: Watch away from home (safely)

Don't forward ports on your router. Use **Tailscale** instead:

1. Install **Tailscale** from the Umbrel App Store and sign in.
2. Install Tailscale on your phone or laptop and sign in with the same account.
3. Use the Umbrel's Tailscale address in Jellyfin: `http://<umbrel-tailscale-ip>:8096`, found in the Tailscale app.

Only devices signed in to your Tailscale account can reach the server.

## Step 11: Optional: separate anime

Anime is better searched on a dedicated site (**Nyaa**), with its own folders.

1. Create the folders `/downloads/anime` and `/downloads/anime-movies` (Umbrel **Files** > Downloads).
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
| qBittorrent's listening port is still 6881 | The VPN hasn't connected or port forwarding is off. Make sure the key came from a config with **NAT-PMP** on, then restart the app. Some Proton servers time out; it keeps trying others, so give it a few minutes. If it still fails, set `SERVER_COUNTRIES` to another country. |
| qBittorrent says "Unauthorized" | Restart the app once. The first start configures it for Umbrel. |
| ipleak shows your home IP | **Stop the app straight away** and check the gluetun custom variables. It shouldn't be possible with this setup, so don't use it until it's fixed. |
| Searches fail in Prowlarr | The VPN may be down: when the VPN is down, the proxy refuses requests on purpose. Check qBittorrent VPN is running. Also try another indexer. |
| A download sits in the queue saying "No files found are eligible" | It was a fake release with only a `.exe` inside, blocked by Step 2e. In Radarr/Sonarr **Activity > Queue**, remove it with **Blocklist release** ticked. This usually happens with episodes that haven't aired yet. |
| Requested item never downloads | Check it has a quality profile and (if you did Step 11) a `regular`/`anime` tag. Then in Radarr/Sonarr open the item and select **Interactive Search** to see why releases were rejected. |
| Jellyfin doesn't show new files | Run **Dashboard > Scan All Libraries**, and check the library folders match `/downloads/movies` and `/downloads/shows`. |
| TV app can't find the server | Enter `http://<umbrel-ip>:8096` by hand; automatic discovery often doesn't work on Umbrel. |
| Umbrel getting slow | Stop apps you don't use (Transmission should already be stopped). 8 GB of RAM is tight with many apps. |

## Keeping it safe

- Your Proton key lives only in the Umbrel app settings. Updating the app keeps it.
- Don't forward ports on your router. Use Tailscale for access away from home.
- Use strong passwords for Umbrel, Jellyfin and qBittorrent.
- One Jellyfin account per person, and only you as admin.
- If an API key or password was ever pasted into a chat or a message, change it: for the Radarr/Sonarr/Prowlarr API keys, use **Settings > General > API Key > regenerate**, then update the key in Seerr.
