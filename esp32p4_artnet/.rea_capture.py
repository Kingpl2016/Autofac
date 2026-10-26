import serial, time, sys

s = serial.Serial()
s.port = 'COM5'
s.baudrate = 115200
s.timeout = 0.2
s.dsrdtr = False
s.rtscts = False
s.open()
# 保证 IO0(BOOT) 高=正常启动；仅用 RTS 脉冲做 EN 复位（等价 esptool hard_reset）
s.dtr = False   # IO0 高
s.rts = False
time.sleep(0.2)
s.rts = True    # EN 低（复位）
time.sleep(0.15)
s.rts = False   # EN 高（运行），IO0 仍高 -> 进应用
end = time.time() + 20
buf = b''
while time.time() < end:
    d = s.read(4096)
    if d:
        buf += d
s.close()
sys.stdout.write(buf.decode('utf-8', 'replace'))
sys.stdout.write("\n----CAPTURED %d BYTES----\n" % len(buf))
