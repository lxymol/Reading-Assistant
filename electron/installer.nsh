!macro preserveLegacyRaidData
  ${If} ${FileExists} "$INSTDIR\RaidData\*.*"
    CreateDirectory "$INSTDIR\..\RaidData"
    ${IfNot} ${FileExists} "$INSTDIR\..\RaidData\UpgradeBackup\*.*"
      StrCpy $R8 "$INSTDIR\..\RaidData\UpgradeBackup"
    ${ElseIfNot} ${FileExists} "$INSTDIR\..\RaidData\UpgradeBackup-2\*.*"
      StrCpy $R8 "$INSTDIR\..\RaidData\UpgradeBackup-2"
    ${ElseIfNot} ${FileExists} "$INSTDIR\..\RaidData\UpgradeBackup-3\*.*"
      StrCpy $R8 "$INSTDIR\..\RaidData\UpgradeBackup-3"
    ${Else}
      StrCpy $R8 "$INSTDIR\..\RaidData\UpgradeBackup-4"
    ${EndIf}
    ClearErrors
    CreateDirectory "$R8"
    CopyFiles /SILENT "$INSTDIR\RaidData\*.*" "$R8"
    ${If} ${Errors}
      MessageBox MB_ICONSTOP|MB_OK "Raid could not preserve the existing RaidData folder. Installation has stopped to prevent data loss."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

; This copies before electron-builder invokes the previous uninstaller, whose
; normal update path recursively removes $INSTDIR. Copying also makes cancelling
; the new installer safe because the old application still has its original data.
!macro customInit
  !insertmacro preserveLegacyRaidData
!macroend

!macro customUnInstall
  !insertmacro preserveLegacyRaidData
  DeleteRegKey HKCU "Software\Classes\*\shell\Raid"
!macroend
