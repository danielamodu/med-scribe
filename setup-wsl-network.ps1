# Get the WSL2 virtual machine IP address
Write-Host "Querying WSL2 IP address..."
try {
    $ips = wsl hostname -I
    if ($null -eq $ips -or $ips.Trim().Length -eq 0) {
        throw "WSL returned empty IP list"
    }
    $wslIp = $ips.Trim().Split(" ")[0]
} catch {
    Write-Error "Failed to retrieve WSL2 IP. Make sure WSL2 is running."
    exit 1
}

Write-Host "Detected WSL2 IP: $wslIp"

# Script block to run as Administrator
$adminScript = {
    param($ip)
    Write-Host "Configuring Windows Port Proxy for Med-Scribe (Port 3001)..."
    
    # Add port proxy rule
    netsh interface portproxy add v4tov4 listenport=3001 listenaddress=0.0.0.0 connectport=3001 connectaddress=$ip
    
    # Add firewall rule (silently override if exists)
    Remove-NetFirewallRule -DisplayName "Med-Scribe WSL2 Port 3001" -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "Med-Scribe WSL2 Port 3001" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -ErrorAction SilentlyContinue
    
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host "Success! Port forwarding is active." -ForegroundColor Green
    Write-Host "Windows Port 3001 is now forwarded to WSL2 IP $ip" -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Active Port Proxy configurations:"
    netsh interface portproxy show all
    Write-Host ""
    Write-Host "Press any key to exit..."
    [void][System.Console]::ReadKey()
}

# Run the script block with elevated permissions
Write-Host "Requesting Administrator permissions to apply network forwarding configurations..."
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& { $adminScript } '$wslIp'"
