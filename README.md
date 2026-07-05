# MAIstro – AI-Powered Music Practice Assistant

MAIstro is a hybrid local music-practice system:

- **Windows/local laptop**: runs **Audiveris** OMR and converts uploaded PNG/JPG sheet music to MusicXML.
- **Raspberry Pi 5**: runs FastAPI, SQLite, real-time pitch detection, WebSocket feedback, and the touchscreen dashboard.
- **MCP server**: exposes MAIstro data and tools for AI/context integration without requiring a chatbot UI.

This repository is not a visual-only mockup. It contains a runnable FastAPI backend, React frontend, SQLite schema, Audiveris wrapper, WebSocket pitch loop, YIN development detector, CREPE-TFLite loading path, and MCP tools/resources.

---

## 0. What you need

### Hardware

- Raspberry Pi 5
- microSD card or SSD
- 7-inch HDMI touchscreen
- ICS-43434 I2S microphone
- MAX98357A I2S DAC amplifier/speaker
- Local laptop with Audiveris installed
- Same Wi-Fi/LAN for laptop and Raspberry Pi

### Software

- Raspberry Pi OS 64-bit Bookworm or later
- Docker + Docker Compose plugin on Raspberry Pi
- Python 3.11+ on laptop for the OMR service
- Audiveris installed on laptop

---

## 1. Laptop: run the Audiveris OMR service

This step is required because Audiveris is heavy and is better handled by the laptop, not the Raspberry Pi.

### 1.1 Install Audiveris

Install Audiveris on the laptop. On Windows, the executable is commonly located at:

```text
C:\Program Files\Audiveris\Audiveris.exe
```

Open Audiveris manually at least once to confirm it launches.

### 1.2 Start the laptop OMR service

Open PowerShell in the project folder:

```powershell
cd C:\Users\YOUR_NAME\Desktop\maistro\laptop_omr
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:AUDIVERIS_CMD="C:\Program Files\Audiveris\Audiveris.exe"
uvicorn main:app --host 0.0.0.0 --port 8100
```

Test it in the laptop browser:

```text
http://localhost:8100/health
```

Expected result:

```json
{
  "status": "ok",
  "audiveris_cmd": "C:\\Program Files\\Audiveris\\Audiveris.exe",
  "audiveris_found": true
}
```

### 1.3 Find the laptop IP address

In PowerShell:

```powershell
ipconfig
```

Look for the **IPv4 Address** under Wi-Fi or Ethernet. Example:

```text
192.168.1.20
```

The Raspberry Pi will use:

```text
OMR_SERVICE_URL=http://192.168.1.20:8100/convert-sheet
```

---

## 2. Raspberry Pi: operating system setup

Flash Raspberry Pi OS using Raspberry Pi Imager.

Recommended settings in Raspberry Pi Imager:

- OS: Raspberry Pi OS 64-bit
- Hostname: `raspberrypi`
- Enable SSH
- Set username/password
- Configure Wi-Fi if needed

After booting, SSH into the Pi:

```bash
ssh pi@raspberrypi.local
```

Update the system:

```bash
sudo apt update && sudo apt upgrade -y
```

Install required packages:

```bash
sudo apt install -y git curl python3-venv python3-pip portaudio19-dev libasound2-dev docker-compose-plugin
```

Install Docker:

```bash
curl -sSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and log back in after adding the user to the Docker group.

---

## 3. Raspberry Pi: enable I2S audio

Edit the boot config:

```bash
sudo nano /boot/firmware/config.txt
```

Add these lines near the bottom:

```text
# MAIstro I2S audio
dtparam=i2s=on
dtoverlay=max98357a
```

For the ICS-43434 microphone, overlay support may vary by OS image. If `arecord -l` does not show the mic after reboot, configure the I2S mic overlay recommended for your installed Raspberry Pi OS kernel or use a USB audio interface for early testing.

Reboot:

```bash
sudo reboot
```

Check audio devices:

```bash
aplay -l
arecord -l
```

Test recording:

```bash
arecord -f S16_LE -r 48000 -c 1 -d 3 /tmp/test.wav
aplay /tmp/test.wav
```

---

## 4. Install MAIstro on the Raspberry Pi

Clone or copy this repository to the Pi:

```bash
cd ~
git clone https://github.com/YOUR_ORG/maistro.git
cd maistro
```

If you copied the ZIP manually, unzip it and enter the folder instead.

Create the `.env` file:

```bash
cp .env.example .env
nano .env
```

For laptop-Audiveris hybrid mode, set:

```text
MAISTRO_AUDIO_SOURCE=hardware
OMR_SERVICE_URL=http://192.168.1.20:8100/convert-sheet
```

Replace `192.168.1.20` with your laptop IPv4 address.

For laptop-only development before the Pi microphone is ready, use:

```text
MAISTRO_AUDIO_SOURCE=browser
OMR_SERVICE_URL=http://127.0.0.1:8100/convert-sheet
```

---

## 5. CREPE-TFLite model

The backend looks for:

```text
backend/models/crepe.tflite
```

Place your quantized CREPE TFLite model there.

If the file is present, the backend uses CREPE-TFLite.

If the file is not present, the backend uses the included **YIN pitch detector**. YIN is a real deterministic pitch algorithm for development testing, not a fake/mock pitch generator. For the final thesis prototype, copy the CREPE `.tflite` model to `backend/models/crepe.tflite` and confirm `/health` reports:

```json
"pitch_engine": "crepe-tflite"
```

---

## 6. Run the system with Docker Compose

From the project root:

```bash
docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f backend
```

Open the dashboard:

```text
http://raspberrypi.local:3000
```

Backend API docs:

```text
http://raspberrypi.local:8000/docs
```

Health check:

```bash
curl http://localhost:8000/health
```

---

## 7. First full workflow

1. Start the laptop OMR service.
2. Start the Raspberry Pi Docker services.
3. Open the MAIstro dashboard.
4. Upload a clear PNG/JPG sheet image.
5. Wait for Audiveris to return MusicXML.
6. Confirm the score appears in the viewer.
7. Choose tempo.
8. Click **Start Practice**.
9. Play the instrument.
10. Watch frequency, cent difference, confidence, and red mistake markers.
11. Click **End Practice**.
12. Review session summary.

---

## 8. API endpoints

### Health

```bash
curl http://localhost:8000/health
```

### Upload sheet

```bash
curl -X POST -F "file=@test_sheet.png" http://localhost:8000/upload-sheet
```

### Start session

```bash
curl -X POST http://localhost:8000/session/start \
  -H "Content-Type: application/json" \
  -d '{"tempo":120,"enable_metronome":true,"enable_feedback":true}'
```

### End session

```bash
curl -X POST http://localhost:8000/session/<SESSION_ID>/end
```

### Stats

```bash
curl http://localhost:8000/stats/<SESSION_ID>
```

---

## 9. MCP integration

MAIstro includes an MCP server in:

```text
backend/mcp_server.py
```

It exposes these MCP tools:

- `get_sheet_metadata(sheet_id)`
- `get_session_summary(session_id)`
- `get_difficult_measures(session_id)`
- `generate_practice_feedback(session_id)`

It exposes these MCP resources:

- `maistro://sheet/{sheet_id}/musicxml`
- `maistro://session/{session_id}/mistakes`

Run it from the project root after installing backend dependencies:

```bash
python -m backend.mcp_server
```

This is intentionally separate from the real-time audio loop. MCP is used for structured AI/context access and post-session feedback, not for 25 ms pitch inference.

---

## 10. Troubleshooting

### Audiveris service returns 500

Most common causes:

- Audiveris path is wrong.
- Image is low-quality, handwritten, skewed, or too blurry.
- Audiveris recognized the score but needs manual correction before export.

Check laptop service health:

```text
http://localhost:8100/health
```

Try opening the same image manually in Audiveris. If manual Audiveris cannot export MusicXML, the API cannot fix that automatically.

### Raspberry Pi cannot reach laptop OMR service

From the Pi:

```bash
curl http://<LAPTOP_IP>:8100/health
```

If it fails:

- Confirm both devices are on the same Wi-Fi/LAN.
- Allow Python/Uvicorn through Windows Firewall.
- Use the laptop IPv4 address, not `localhost`.

### No hardware microphone input

Check:

```bash
arecord -l
```

If no capture device appears, fix the I2S overlay or temporarily use browser mode:

```text
MAISTRO_AUDIO_SOURCE=browser
```

Then rebuild/restart:

```bash
docker compose up -d --build
```

### Backend says YIN instead of CREPE

Check that the file exists:

```bash
ls -lh backend/models/crepe.tflite
```

Then restart:

```bash
docker compose restart backend
curl http://localhost:8000/health
```

---

## 11. Thesis implementation notes

Use this description in your defense:

> MAIstro uses a hybrid local architecture. The laptop runs Audiveris for OMR because sheet transcription is computationally heavier and may require manual correction. The Raspberry Pi 5 handles real-time audio capture, pitch inference, WebSocket feedback, local SQLite logging, and the touchscreen interface. MCP is integrated as a structured tool/resource layer for AI-assisted retrieval of MusicXML, session statistics, mistakes, difficult measures, and practice recommendations. MCP is not used for the low-latency audio loop.

