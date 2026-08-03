param(
    [Parameter(Mandatory = $true)]
    [string] $DxcPath,

    [ValidateRange(1, 20)]
    [int] $Iterations = 3,

    [ValidateSet('O3', 'Od')]
    [string] $Optimization = 'O3'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $DxcPath -PathType Leaf)) {
    throw "DXC executable not found: $DxcPath"
}

$fixtureDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$fixtures = @(
    @{ Name = 'aggregate-zero'; Path = Join-Path $fixtureDirectory 'aggregate-zero.hlsl' },
    @{ Name = 'flat-aggregate-zero'; Path = Join-Path $fixtureDirectory 'flat-aggregate-zero.hlsl' },
    @{ Name = 'loop-zero'; Path = Join-Path $fixtureDirectory 'loop-zero.hlsl' },
    @{ Name = 'no-zero'; Path = Join-Path $fixtureDirectory 'no-zero.hlsl' }
)

$results = foreach ($fixture in $fixtures) {
    for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
        $outputPath = Join-Path ([System.IO.Path]::GetTempPath()) "shinobu-$($fixture.Name)-$PID-$iteration.dxil"
        try {
            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            $process = Start-Process -FilePath $DxcPath -ArgumentList @(
                '-T', 'cs_6_0',
                '-E', 'main',
                '-HV', '2018',
                "-$Optimization",
                '-Fo', $outputPath,
                $fixture.Path
            ) -NoNewWindow -Wait -PassThru
            $stopwatch.Stop()

            if ($process.ExitCode -ne 0) {
                throw "DXC failed for $($fixture.Name) with exit code $($process.ExitCode)"
            }

            [pscustomobject]@{
                Fixture = $fixture.Name
                Iteration = $iteration
                Milliseconds = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 2)
            }
        }
        finally {
            Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
        }
    }
}

$summaries = foreach ($fixture in $fixtures) {
    $times = @($results | Where-Object Fixture -eq $fixture.Name | Select-Object -ExpandProperty Milliseconds | Sort-Object)
    $median = if ($times.Count % 2 -eq 1) {
        $times[[math]::Floor($times.Count / 2)]
    }
    else {
        ($times[$times.Count / 2 - 1] + $times[$times.Count / 2]) / 2
    }

    [pscustomobject]@{
        Fixture = $fixture.Name
        MedianMilliseconds = [math]::Round($median, 2)
        MinimumMilliseconds = [math]::Round(($times | Measure-Object -Minimum).Minimum, 2)
        MaximumMilliseconds = [math]::Round(($times | Measure-Object -Maximum).Maximum, 2)
    }
}

$aggregate = $summaries | Where-Object Fixture -eq 'aggregate-zero'
$loop = $summaries | Where-Object Fixture -eq 'loop-zero'
$noZero = $summaries | Where-Object Fixture -eq 'no-zero'

[pscustomobject]@{
    DxcVersion = (& $DxcPath --version | Select-Object -First 1)
    Optimization = $Optimization
    Iterations = $Iterations
    Samples = $results
    Summary = $summaries
    Ratios = [pscustomobject]@{
        AggregateToLoop = [math]::Round($aggregate.MedianMilliseconds / $loop.MedianMilliseconds, 2)
        AggregateToNoZero = [math]::Round($aggregate.MedianMilliseconds / $noZero.MedianMilliseconds, 2)
    }
} | ConvertTo-Json -Depth 6
