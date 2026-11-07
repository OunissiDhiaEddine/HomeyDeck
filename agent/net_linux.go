//go:build linux

package main

import (
	"unsafe"

	"golang.org/x/sys/unix"
)

// magicPacketWake asks the network driver (the ETHTOOL_GWOL ioctl, which
// needs no root) whether the card wakes the PC on a magic packet.
func magicPacketWake(iface string) (bool, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return false, err
	}
	defer unix.Close(fd)

	var wol struct {
		cmd, supported, wolopts uint32
		sopass                  [6]byte
	}
	wol.cmd = unix.ETHTOOL_GWOL
	var req struct {
		name [unix.IFNAMSIZ]byte
		data unsafe.Pointer
		_    [16]byte // the rest of struct ifreq
	}
	copy(req.name[:unix.IFNAMSIZ-1], iface)
	req.data = unsafe.Pointer(&wol)
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.SIOCETHTOOL, uintptr(unsafe.Pointer(&req))); errno != 0 {
		return false, errno
	}
	return wol.wolopts&unix.WAKE_MAGIC != 0, nil
}
