#!/usr/bin/env bash
set -euo pipefail

# Remove old lab namespaces if they exist
for ns in tsa-client tsa-router tsa-server; do
    sudo ip netns del "$ns" 2>/dev/null || true
done

# Create namespaces
sudo ip netns add tsa-client
sudo ip netns add tsa-router
sudo ip netns add tsa-server

# Create virtual Ethernet pairs
sudo ip link add c0 type veth peer name r0
sudo ip link add r1 type veth peer name s0

# Move interfaces into namespaces
sudo ip link set c0 netns tsa-client
sudo ip link set r0 netns tsa-router
sudo ip link set r1 netns tsa-router
sudo ip link set s0 netns tsa-server

# Enable loopback
for ns in tsa-client tsa-router tsa-server; do
    sudo ip -n "$ns" link set lo up
done

# Assign IP addresses
sudo ip -n tsa-client addr add 10.10.1.2/24 dev c0
sudo ip -n tsa-router addr add 10.10.1.1/24 dev r0
sudo ip -n tsa-router addr add 10.10.2.1/24 dev r1
sudo ip -n tsa-server addr add 10.10.2.2/24 dev s0

# Enable interfaces
sudo ip -n tsa-client link set c0 up
sudo ip -n tsa-router link set r0 up
sudo ip -n tsa-router link set r1 up
sudo ip -n tsa-server link set s0 up

# Configure routes
sudo ip -n tsa-client route add default via 10.10.1.1
sudo ip -n tsa-server route add default via 10.10.2.1

# Enable router forwarding
sudo ip netns exec tsa-router sysctl -w net.ipv4.ip_forward=1

echo "Telecom Assurance Lab created successfully."
