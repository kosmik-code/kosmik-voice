; Kosmik Voice installer hooks (Tauri NSIS).

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Start with Windows" entry written by the app (tauri-plugin-autostart / auto-launch).
  ; Kept during updates, which uninstall the old version first.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  ${EndIf}
  ; Settings, pictures and Discord login live in %APPDATA%\Kosmik Voice: removed only when the
  ; "Delete the application data" box was ticked.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\Kosmik Voice"
  ${EndIf}
!macroend
