; Opens port 4000 to the local network so candidate computers can reach the exam server.
; Restricted to the local subnet (not the internet) and removed again on uninstall.
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SyncBee Exam Server"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="SyncBee Exam Server" dir=in action=allow protocol=TCP localport=4000 remoteip=LocalSubnet profile=any'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SyncBee Exam Server"'
!macroend