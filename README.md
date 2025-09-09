# Vélib' Export (CSV)

Tampermonkey userscript to export your Vélib' ride history to CSV.

## Install
1. Install Tampermonkey
2. Click this link: https://raw.githubusercontent.com/MLasserre/velib-export/main/velib-export.user.js
3. Tampermonkey will prompt to install.

## Usage
- Open **Mes trajets** (`/private/account#/my-runs`).
- Click **Export rides (CSV)** in the header.
- A CSV will download with columns:
  `date_operation,bike_number,bike_type,distance_km,duration_hms,avg_speed_kmh,price_eur,co2_g`.

## Notes
- Tested on Firefox with Tampermonkey.

## Updating
The script auto-updates when a new version is pushed. You can also click
**Tampermonkey → Check for updates**.

## License
MIT

