# Home Apps

Community app store for umbrelOS.

**Setting up a media server?** Follow [MEDIA-SERVER-SETUP.md](MEDIA-SERVER-SETUP.md). It sets up Jellyfin with automatic downloads over a VPN, step by step, on an Umbrel or on any computer that runs Docker (Linux, Windows, Mac or a NAS). An AI assistant can follow it for you too.

## qBittorrent VPN

qBittorrent routed through [Gluetun](https://github.com/qdm12/gluetun) to Proton VPN (WireGuard, port forwarding on).
qBittorrent shares Gluetun's network, so it has no internet access at all when the VPN is down.

### Setup

1. **Proton VPN:** a paid plan (Plus or higher) is needed for P2P. In the Proton dashboard go to
   Downloads > WireGuard configuration, pick platform **Router** (or GNU/Linux), turn on
   **NAT-PMP (Port Forwarding)**, choose any P2P server and create the config. Copy the `PrivateKey` line's value.
2. **Add this store to Umbrel:** App Store > ⋯ > Community App Stores > paste this repo's URL.
3. **Install "qBittorrent VPN"** from the store.
4. **Add the key:** right-click the app > Settings > Advanced > Custom variables, add
   `WIREGUARD_PRIVATE_KEY` for the `gluetun` service. Optionally add `SERVER_COUNTRIES` (e.g. `United States`). Save.
   Never commit the key to this repo.
5. **qBittorrent web UI** (login `admin` / `adminadmin`): change the password under Tools > Options > WebUI.
   On first start, `hooks/post-start` configures qBittorrent for the Umbrel proxy, allows localhost
   (so Gluetun can set the forwarded port) and the Umbrel app network (Radarr/Sonarr) without a password,
   and keeps the save path at `/downloads`.
6. **Radarr and Sonarr:** Settings > Download Clients > add qBittorrent, host `home-qbittorrent-vpn_gluetun_1`,
   port `8080`, no username/password. Remove the old Transmission/qBittorrent clients.

### Check it's working

In qBittorrent go to Tools > Options > Connection. The listening port should be a Proton-assigned
number, not 6881. Then add a torrent IP checker, such as the magnet link from
[ipleak.net](https://ipleak.net) ("Torrent Address detection"). It should show a Proton IP, not your home IP.

## Core Keeper

A Core Keeper dedicated server ([escapingnetwork/core-keeper-dedicated](https://github.com/escapingnetwork/core-keeper-dedicated)).
Players join over Steam's relay with the Game ID, so no ports are opened on the router.

1. Install "Core Keeper" and open it. The first start downloads the server from Steam (about 600 MB).
2. When the page shows the Game ID, players join in Core Keeper with Play > Join game > Game ID.
3. The ID is kept in `ServerConfig.json` in the app data, so it stays the same across restarts.
   It's never stored in this repo; anyone with it can join.

The server updates from Steam on every start. Optional custom variables for the `server` service:
`WORLD_NAME`, `WORLD_MODE` (0 Normal, 1 Hard, 2 Creative, 4 Casual), `MAX_PLAYERS`, `WORLD_SEED`.
