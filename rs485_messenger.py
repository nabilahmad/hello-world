"""
RS485 Messenger - A simple GUI tool for sending/receiving RS485 messages on Windows 11.
Requires: pyserial  (pip install pyserial)
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import serial
import serial.tools.list_ports
import threading
import time


class RS485Messenger:
    def __init__(self, root):
        self.root = root
        self.root.title("RS485 Messenger")
        self.root.resizable(True, True)
        self.root.minsize(600, 560)

        self.serial_port = None
        self.rx_thread = None
        self.rx_running = False

        self._build_ui()

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        pad = {"padx": 6, "pady": 4}

        # ── Connection frame ──────────────────────────────────────────
        conn_frame = ttk.LabelFrame(self.root, text="Connection")
        conn_frame.pack(fill="x", padx=10, pady=(10, 4))

        # Row 0 – port + baud
        ttk.Label(conn_frame, text="Port:").grid(row=0, column=0, sticky="e", **pad)
        self.port_var = tk.StringVar()
        self.port_combo = ttk.Combobox(conn_frame, textvariable=self.port_var, width=12)
        self.port_combo.grid(row=0, column=1, sticky="w", **pad)

        ttk.Button(conn_frame, text="Refresh", command=self._refresh_ports).grid(
            row=0, column=2, **pad
        )

        ttk.Label(conn_frame, text="Baud:").grid(row=0, column=3, sticky="e", **pad)
        self.baud_var = tk.StringVar(value="9600")
        baud_combo = ttk.Combobox(
            conn_frame,
            textvariable=self.baud_var,
            values=["1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200"],
            width=8,
        )
        baud_combo.grid(row=0, column=4, sticky="w", **pad)

        # Row 1 – data bits / parity / stop bits
        ttk.Label(conn_frame, text="Data bits:").grid(row=1, column=0, sticky="e", **pad)
        self.databits_var = tk.StringVar(value="8")
        ttk.Combobox(
            conn_frame,
            textvariable=self.databits_var,
            values=["5", "6", "7", "8"],
            width=4,
        ).grid(row=1, column=1, sticky="w", **pad)

        ttk.Label(conn_frame, text="Parity:").grid(row=1, column=2, sticky="e", **pad)
        self.parity_var = tk.StringVar(value="None")
        ttk.Combobox(
            conn_frame,
            textvariable=self.parity_var,
            values=["None", "Even", "Odd", "Mark", "Space"],
            width=6,
        ).grid(row=1, column=3, sticky="w", **pad)

        ttk.Label(conn_frame, text="Stop bits:").grid(row=1, column=4, sticky="e", **pad)
        self.stopbits_var = tk.StringVar(value="1")
        ttk.Combobox(
            conn_frame,
            textvariable=self.stopbits_var,
            values=["1", "1.5", "2"],
            width=4,
        ).grid(row=1, column=5, sticky="w", **pad)

        # Row 2 – RS485 options
        self.rts_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            conn_frame,
            text="RTS toggles RS485 direction (half-duplex)",
            variable=self.rts_var,
        ).grid(row=2, column=0, columnspan=4, sticky="w", **pad)

        self.echo_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            conn_frame, text="Echo TX in log", variable=self.echo_var
        ).grid(row=2, column=4, columnspan=2, sticky="w", **pad)

        # Row 3 – connect / disconnect
        btn_frame = ttk.Frame(conn_frame)
        btn_frame.grid(row=3, column=0, columnspan=6, pady=(2, 6))

        self.connect_btn = ttk.Button(btn_frame, text="Connect", command=self._connect)
        self.connect_btn.pack(side="left", padx=6)
        self.disconnect_btn = ttk.Button(
            btn_frame, text="Disconnect", command=self._disconnect, state="disabled"
        )
        self.disconnect_btn.pack(side="left", padx=6)

        self.status_lbl = ttk.Label(btn_frame, text="● Disconnected", foreground="red")
        self.status_lbl.pack(side="left", padx=12)

        # ── Message frame ─────────────────────────────────────────────
        msg_frame = ttk.LabelFrame(self.root, text="Send Message")
        msg_frame.pack(fill="x", padx=10, pady=4)

        self.mode_var = tk.StringVar(value="ASCII")
        for txt in ("ASCII", "Hex"):
            ttk.Radiobutton(
                msg_frame, text=txt, variable=self.mode_var, value=txt
            ).pack(side="left", padx=6, pady=4)

        self.msg_entry = ttk.Entry(msg_frame, width=50)
        self.msg_entry.pack(side="left", padx=6, pady=4, fill="x", expand=True)
        self.msg_entry.bind("<Return>", lambda _e: self._send())

        ttk.Button(msg_frame, text="Send", command=self._send).pack(
            side="left", padx=6, pady=4
        )
        ttk.Button(msg_frame, text="Clear", command=lambda: self.msg_entry.delete(0, "end")).pack(
            side="left", padx=2, pady=4
        )

        # Hex hint
        self.hex_hint = ttk.Label(
            msg_frame,
            text="e.g. 01 03 00 00 00 02 C4 0B",
            foreground="gray",
        )
        # shown only in Hex mode – packed dynamically in _toggle_mode
        self.mode_var.trace_add("write", self._toggle_mode)

        # ── Quick-send presets ────────────────────────────────────────
        preset_frame = ttk.LabelFrame(self.root, text="Quick Send Presets")
        preset_frame.pack(fill="x", padx=10, pady=4)

        presets = [
            ("Modbus read (example)", "hex", "01 03 00 00 00 02 C4 0B"),
            ("CR/LF ping",            "ascii", "\r\n"),
            ("ENQ",                   "ascii", "\x05"),
        ]
        for label, mode, payload in presets:
            ttk.Button(
                preset_frame,
                text=label,
                command=lambda m=mode, p=payload: self._send_preset(m, p),
            ).pack(side="left", padx=4, pady=4)

        # ── Log frame ─────────────────────────────────────────────────
        log_frame = ttk.LabelFrame(self.root, text="Log")
        log_frame.pack(fill="both", expand=True, padx=10, pady=(4, 10))

        self.log = scrolledtext.ScrolledText(
            log_frame, state="disabled", wrap="word", height=14, font=("Consolas", 9)
        )
        self.log.pack(fill="both", expand=True, padx=4, pady=4)

        log_btn_frame = ttk.Frame(log_frame)
        log_btn_frame.pack(fill="x", padx=4, pady=(0, 4))
        ttk.Button(log_btn_frame, text="Clear Log", command=self._clear_log).pack(side="left")

        ttk.Label(
            log_btn_frame,
            text="TX=blue  RX=green  INFO=gray  ERROR=red",
            foreground="gray",
        ).pack(side="right", padx=4)

        # Tag colours
        self.log.tag_config("TX",    foreground="#1a6fba")
        self.log.tag_config("RX",    foreground="#1a8a3a")
        self.log.tag_config("INFO",  foreground="#888888")
        self.log.tag_config("ERROR", foreground="#cc2222")

        # ── Populate ports on start ───────────────────────────────────
        self._refresh_ports()
        self._toggle_mode()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _toggle_mode(self, *_):
        if self.mode_var.get() == "Hex":
            self.hex_hint.pack(side="left", padx=4)
        else:
            self.hex_hint.pack_forget()

    def _refresh_ports(self):
        ports = [p.device for p in serial.tools.list_ports.comports()]
        self.port_combo["values"] = ports
        if ports and not self.port_var.get():
            self.port_var.set(ports[0])
        self._log("INFO", f"Available ports: {', '.join(ports) if ports else 'none found'}")

    def _log(self, tag: str, text: str):
        timestamp = time.strftime("%H:%M:%S")
        self.log.configure(state="normal")
        self.log.insert("end", f"[{timestamp}] [{tag}] {text}\n", tag)
        self.log.configure(state="disabled")
        self.log.see("end")

    def _clear_log(self):
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    # ------------------------------------------------------------------
    # Serial helpers
    # ------------------------------------------------------------------

    _PARITY_MAP = {
        "None": serial.PARITY_NONE,
        "Even": serial.PARITY_EVEN,
        "Odd":  serial.PARITY_ODD,
        "Mark": serial.PARITY_MARK,
        "Space": serial.PARITY_SPACE,
    }
    _STOPBITS_MAP = {
        "1": serial.STOPBITS_ONE,
        "1.5": serial.STOPBITS_ONE_POINT_FIVE,
        "2": serial.STOPBITS_TWO,
    }

    def _connect(self):
        port = self.port_var.get().strip()
        if not port:
            messagebox.showwarning("No Port", "Select a COM port first.")
            return
        try:
            self.serial_port = serial.Serial(
                port=port,
                baudrate=int(self.baud_var.get()),
                bytesize=int(self.databits_var.get()),
                parity=self._PARITY_MAP[self.parity_var.get()],
                stopbits=self._STOPBITS_MAP[self.stopbits_var.get()],
                timeout=0.1,
                rtscts=False,
                dsrdtr=False,
            )
            if self.rts_var.get():
                # RTS low = receive mode initially
                self.serial_port.rts = False
        except serial.SerialException as exc:
            messagebox.showerror("Connection Error", str(exc))
            return

        self.connect_btn.configure(state="disabled")
        self.disconnect_btn.configure(state="normal")
        self.status_lbl.configure(text="● Connected", foreground="green")
        self._log("INFO", f"Connected to {port} @ {self.baud_var.get()} baud")

        self.rx_running = True
        self.rx_thread = threading.Thread(target=self._rx_loop, daemon=True)
        self.rx_thread.start()

    def _disconnect(self):
        self.rx_running = False
        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()
        self.serial_port = None
        self.connect_btn.configure(state="normal")
        self.disconnect_btn.configure(state="disabled")
        self.status_lbl.configure(text="● Disconnected", foreground="red")
        self._log("INFO", "Disconnected")

    # ------------------------------------------------------------------
    # RX background thread
    # ------------------------------------------------------------------

    def _rx_loop(self):
        buffer = b""
        while self.rx_running:
            try:
                if self.serial_port and self.serial_port.in_waiting:
                    chunk = self.serial_port.read(self.serial_port.in_waiting)
                    buffer += chunk
                    # Flush buffer on newline or after a short idle
                    if b"\n" in buffer or b"\r" in buffer:
                        lines = buffer.split(b"\n")
                        for line in lines[:-1]:
                            self._rx_display(line + b"\n")
                        buffer = lines[-1]
                else:
                    if buffer:
                        time.sleep(0.05)
                        if not (self.serial_port and self.serial_port.in_waiting):
                            self._rx_display(buffer)
                            buffer = b""
                    time.sleep(0.02)
            except Exception as exc:
                self.root.after(0, self._log, "ERROR", f"RX error: {exc}")
                break

    def _rx_display(self, data: bytes):
        if not data:
            return
        try:
            text = data.decode("utf-8", errors="replace").rstrip("\r\n")
        except Exception:
            text = ""
        hex_str = data.hex(" ").upper()
        self.root.after(0, self._log, "RX", f"ASCII: {text!r}  HEX: {hex_str}")

    # ------------------------------------------------------------------
    # TX
    # ------------------------------------------------------------------

    def _send(self):
        if not (self.serial_port and self.serial_port.is_open):
            messagebox.showwarning("Not Connected", "Connect to a port first.")
            return

        raw = self.msg_entry.get()
        if not raw:
            return

        try:
            if self.mode_var.get() == "Hex":
                # Accept "01 03 00" or "010300" formats
                cleaned = raw.replace(" ", "").replace(":", "")
                if len(cleaned) % 2:
                    raise ValueError("Hex string has odd number of nibbles")
                payload = bytes.fromhex(cleaned)
            else:
                payload = raw.encode("utf-8")
        except ValueError as exc:
            messagebox.showerror("Invalid Input", str(exc))
            return

        try:
            if self.rts_var.get():
                self.serial_port.rts = True   # drive RS485 TX enable
                time.sleep(0.001)

            self.serial_port.write(payload)
            self.serial_port.flush()

            if self.rts_var.get():
                # Wait for bytes to physically leave the UART before releasing bus
                byte_time = len(payload) * 10 / int(self.baud_var.get())
                time.sleep(byte_time + 0.002)
                self.serial_port.rts = False  # back to receive mode
        except serial.SerialException as exc:
            self._log("ERROR", f"TX error: {exc}")
            return

        if self.echo_var.get():
            self._log("TX", f"{payload.hex(' ').upper()}  ({raw!r})")

    def _send_preset(self, mode: str, payload: str):
        self.mode_var.set("Hex" if mode == "hex" else "ASCII")
        self.msg_entry.delete(0, "end")
        if mode == "hex":
            self.msg_entry.insert(0, payload)
        else:
            self.msg_entry.insert(0, payload)
        self._send()


# ──────────────────────────────────────────────────────────────────────
def main():
    root = tk.Tk()
    app = RS485Messenger(root)
    root.protocol("WM_DELETE_WINDOW", lambda: (app._disconnect(), root.destroy()))
    root.mainloop()


if __name__ == "__main__":
    main()
