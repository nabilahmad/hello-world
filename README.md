# hello-world
first test how does this work?

bla bla bla

---

# RS485 Messenger

A simple Python/tkinter GUI for sending and receiving RS485 messages on Windows 11.

## Requirements

- Python 3.8+ (https://python.org)
- A USB-to-RS485 adapter (shows up as a COM port)

## Install & Run

```bat
pip install pyserial
python rs485_messenger.py
```

## Features

| Feature | Details |
|---|---|
| Port selection | Auto-detects all COM ports; Refresh button to rescan |
| Baud rate | 1200 – 115200 |
| Frame format | Data bits 5-8, Parity None/Even/Odd/Mark/Space, Stop bits 1/1.5/2 |
| TX modes | **ASCII** – type plain text; **Hex** – space- or colon-separated bytes e.g. `01 03 00 00 00 02 C4 0B` |
| RTS direction | Checkbox toggles RTS high before TX and low after, for half-duplex RS485 adapters |
| Echo TX | Optionally show sent bytes in the log |
| Receive | Background thread; shows both ASCII repr and hex dump |
| Quick presets | One-click Modbus read example, CR/LF ping, ENQ |
| Log colours | TX=blue, RX=green, INFO=gray, ERROR=red |

## Notes

- Most cheap USB-RS485 dongles handle the TX/RX direction switching in hardware; in that case you can leave **RTS toggles RS485 direction** unchecked.
- If you need Modbus CRC calculation, add the `crcmod` package and compute CRC16/MODBUS before sending.
