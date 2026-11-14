param([Parameter(Mandatory=$true)][string]$Capture)
$ErrorActionPreference='Stop'
$settings=[Xml.XmlReaderSettings]::new()
$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit
$settings.XmlResolver=$null
$settings.MaxCharactersInDocument=16777216
$file=[IO.File]::OpenRead($Capture)
try {
    if ($file.Length -gt 16777216){throw 'renderdoc_xml_limit'}
    $reader=[Xml.XmlReader]::Create($file,$settings)
    try {
        $doc=[Xml.XmlDocument]::new()
        $doc.XmlResolver=$null
        $doc.Load($reader)
    } finally {$reader.Dispose()}
} finally {$file.Dispose()}
$driver=$doc.SelectSingleNode('/rdc/header/driver')
if (!$driver -or $driver.InnerText -notin @('OpenGL','D3D11','D3D12','Vulkan')){throw 'renderdoc_xml_unsupported'}
$frame=$false
$rasterStates=@{}
$actions=[Collections.Generic.List[object]]::new()
$matched=0
foreach ($chunk in $doc.SelectNodes('/rdc/chunks/chunk')) {
    $name=$chunk.GetAttribute('name')
    if ($name -match '^ID3D11Device[0-9]*::CreateRasterizerState[0-9]*$') {
        $id=$chunk.SelectSingleNode('ResourceId[@name="pState"]')
        $flag=$chunk.SelectSingleNode('struct/bool[@name="ScissorEnable"]')
        if ($id -and $flag -and $flag.InnerText -in @('true','false')){$rasterStates[$id.InnerText]=[int]($flag.InnerText -eq 'true')}
    }
    if ($name -eq 'Internal::Beginning of Capture' -or $name -eq 'Internal::Begin Capture Frame'){$frame=$true; continue}
    if (!$frame){continue}
    $switch=$name -in @('glEnable','glDisable') -and $chunk.SelectSingleNode('enum[@name="cap" and @string="GL_SCISSOR_TEST"]')
    $binding=$name -match '^ID3D11DeviceContext[0-9]*::RSSetState$'
    if (!$switch -and !$binding -and $name -notmatch '^(gl(Draw|MultiDraw|Dispatch|Scissor)[A-Za-z0-9_]*|(ID3D11DeviceContext[0-9]*|ID3D12GraphicsCommandList[0-9]*)::(Draw|Dispatch|RSSetScissor)[A-Za-z0-9_]*|vkCmd(Draw|Dispatch|SetScissor)[A-Za-z0-9_]*)$'){continue}
    $matched++
    if ($actions.Count -ge 100){continue}
    $values=[ordered]@{}
    if ($switch){$values.scissorEnabled=[int]($name -eq 'glEnable')}
    if ($binding){
        $id=$chunk.SelectSingleNode('ResourceId[@name="pRasterizerState"]')
        if ($id -and $rasterStates.ContainsKey($id.InnerText)){$values.scissorEnabled=$rasterStates[$id.InnerText]}
    }
    foreach ($item in $chunk.SelectNodes('.//int|.//uint')) {
        $key=$item.GetAttribute('name')
        if ($key -notin @('count','VertexCount','IndexCount','InstanceCount','width','height','left','right','top','bottom')){continue}
        [long]$n=0
        if ([long]::TryParse($item.InnerText,[ref]$n)){$values[$key]=$n}
    }
    $actions.Add(@{chunk=[int]$chunk.GetAttribute('chunkIndex');call=$name;values=$values})
}
if (!$frame){throw 'renderdoc_xml_missing_frame'}
@{api=$driver.InnerText;actionCount=$matched;actions=$actions.ToArray()}|ConvertTo-Json -Depth 6 -Compress
