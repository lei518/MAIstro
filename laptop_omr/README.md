# MAIstro Laptop Audiveris OMR Service

Run this on the Windows laptop where Audiveris is installed. The Raspberry Pi backend calls this service using `OMR_SERVICE_URL`.

## Windows setup

```powershell
cd C:\Users\YOUR_NAME\Desktop\maistro\laptop_omr
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:AUDIVERIS_CMD="C:\Program Files\Audiveris\Audiveris.exe"
uvicorn main:app --host 0.0.0.0 --port 8100
```

Open this in the laptop browser:

```text
http://localhost:8100/health
```

Then set this in the Raspberry Pi `.env` file:

```text
OMR_SERVICE_URL=http://<LAPTOP_IP_ADDRESS>:8100/convert-sheet
```

To find your laptop IP on Windows:

```powershell
ipconfig
```

Use the IPv4 address from the same Wi-Fi/LAN network as the Raspberry Pi.
