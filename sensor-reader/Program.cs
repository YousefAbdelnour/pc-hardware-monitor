using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;

internal static class Program
{
    private const string ListenPrefix = "http://127.0.0.1:8095/";

    private static void Main()
    {
        var serializer = new JavaScriptSerializer();

        using (var reader = new TelemetryReader())
        using (var listener = new HttpListener())
        {
            var shouldStop = false;

            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs args)
            {
                args.Cancel = true;
                shouldStop = true;
                StopListener(listener);
            };

            listener.Prefixes.Add(ListenPrefix);
            listener.Start();

            while (!shouldStop)
            {
                HttpListenerContext context;

                try
                {
                    context = listener.GetContext();
                }
                catch (HttpListenerException)
                {
                    if (shouldStop || !listener.IsListening)
                    {
                        break;
                    }

                    throw;
                }
                catch (ObjectDisposedException)
                {
                    if (shouldStop)
                    {
                        break;
                    }

                    throw;
                }

                try
                {
                    var path = NormalizePath(context.Request.Url);

                    if (path == string.Empty || path == "/health")
                    {
                        WriteJson(context.Response, HttpStatusCode.OK, new HealthPayload(), serializer);
                        continue;
                    }

                    if (path == "/metrics")
                    {
                        WriteJson(context.Response, HttpStatusCode.OK, reader.ReadMetrics(), serializer);
                        continue;
                    }

                    WriteJson(
                        context.Response,
                        HttpStatusCode.NotFound,
                        new ErrorPayload("Not found"),
                        serializer
                    );
                }
                catch (Exception error)
                {
                    WriteJson(
                        context.Response,
                        HttpStatusCode.InternalServerError,
                        new ErrorPayload(error.Message),
                        serializer
                    );
                }
            }
        }
    }

    private static string NormalizePath(Uri url)
    {
        if (url == null)
        {
            return string.Empty;
        }

        var path = url.AbsolutePath ?? string.Empty;
        if (path.Length > 1 && path.EndsWith("/", StringComparison.Ordinal))
        {
            path = path.Substring(0, path.Length - 1);
        }

        return path.ToLowerInvariant();
    }

    private static void StopListener(HttpListener listener)
    {
        try
        {
            if (listener.IsListening)
            {
                listener.Stop();
            }
        }
        catch
        {
            // The process is already exiting.
        }
    }

    private static void WriteJson(
        HttpListenerResponse response,
        HttpStatusCode statusCode,
        object payload,
        JavaScriptSerializer serializer
    )
    {
        var buffer = Encoding.UTF8.GetBytes(serializer.Serialize(payload));
        response.StatusCode = (int)statusCode;
        response.ContentType = "application/json; charset=utf-8";
        response.ContentLength64 = buffer.Length;
        response.OutputStream.Write(buffer, 0, buffer.Length);
        response.Close();
    }

}

internal sealed class TelemetryReader : IDisposable
{
    private static readonly TimeSpan SnapshotCacheDuration = TimeSpan.FromMilliseconds(150);

    private readonly object syncLock = new object();
    private readonly Computer computer;
    private DateTimeOffset lastSampledAt = DateTimeOffset.MinValue;
    private SensorMetricsPayload lastSnapshot;

    public TelemetryReader()
    {
        computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsMotherboardEnabled = true,
            IsStorageEnabled = true,
        };
        computer.Open();
    }

    public SensorMetricsPayload ReadMetrics()
    {
        lock (syncLock)
        {
            var sampledAt = DateTimeOffset.UtcNow;
            if (lastSnapshot != null && sampledAt - lastSampledAt <= SnapshotCacheDuration)
            {
                return lastSnapshot;
            }

            lastSnapshot = CaptureMetrics(sampledAt);
            lastSampledAt = sampledAt;
            return lastSnapshot;
        }
    }

    public void Dispose()
    {
        computer.Close();
    }

    private SensorMetricsPayload CaptureMetrics(DateTimeOffset sampledAt)
    {
        var hardwareSnapshots = new List<HardwareSnapshot>();
        foreach (var hardware in computer.Hardware)
        {
            SnapshotHardware(hardware, new List<string>(), hardwareSnapshots);
        }

        var cpuHardware = hardwareSnapshots.FirstOrDefault(hardware => hardware.Type == HardwareType.Cpu);
        var gpuHardware = SelectPrimaryGpu(hardwareSnapshots);
        var boardSensors = hardwareSnapshots
            .Where(hardware => IsBoardHardwareType(hardware.Type))
            .SelectMany(hardware => hardware.Sensors)
            .ToList();
        var storageHardware = hardwareSnapshots
            .Where(hardware => hardware.Type == HardwareType.Storage)
            .ToList();

        return new SensorMetricsPayload
        {
            cpu = cpuHardware == null ? new CpuMetrics() : ReadCpuMetrics(cpuHardware),
            gpu = gpuHardware == null ? new GpuMetrics() : ReadGpuMetrics(gpuHardware),
            motherboard = new TemperatureMetrics { temp = ReadBoardTemperature(boardSensors) },
            storage = new TemperatureMetrics { temp = ReadStorageTemperature(storageHardware) },
            fans = ReadFans(hardwareSnapshots),
            source = ServiceMetadata.SourceName,
            sampled_at = sampledAt.ToString("O"),
        };
    }

    private static void SnapshotHardware(
        IHardware hardware,
        List<string> parentPath,
        List<HardwareSnapshot> snapshots
    )
    {
        hardware.Update();

        var hardwareName = CleanText(hardware.Name);
        var path = new List<string>(parentPath);
        path.Add(hardwareName);

        var sensors = hardware.Sensors
            .Select(
                sensor => new SensorSnapshot
                {
                    Type = sensor.SensorType,
                    Name = CleanText(sensor.Name),
                    Value = sensor.Value,
                    Path = new List<string>(path),
                }
            )
            .ToList();

        snapshots.Add(
            new HardwareSnapshot
            {
                Type = hardware.HardwareType,
                Name = hardwareName,
                Path = path,
                Sensors = sensors,
            }
        );

        foreach (var subHardware in hardware.SubHardware)
        {
            SnapshotHardware(subHardware, path, snapshots);
        }
    }

    private static CpuMetrics ReadCpuMetrics(HardwareSnapshot hardware)
    {
        return new CpuMetrics
        {
            usage = PreferredValue(
                hardware.Sensors,
                SensorType.Load,
                new[] { "CPU Total" },
                delegate(SensorSnapshot sensor) { return ContainsAny(sensor.Name, "cpu total", "total"); }
            ),
            temp = PreferredValue(
                hardware.Sensors,
                SensorType.Temperature,
                new[] { "Core (Tctl/Tdie)", "CPU Package", "Package" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "tctl", "tdie", "package");
                }
            ),
            clock_mhz = PreferredValue(
                hardware.Sensors,
                SensorType.Clock,
                new[] { "Cores (Average)" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "average") && !ContainsAny(sensor.Name, "effective");
                }
            ),
            power_w = PreferredValue(
                hardware.Sensors,
                SensorType.Power,
                new[] { "Package", "CPU Package", "Total" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "package", "cpu package");
                }
            ),
        };
    }

    private static GpuMetrics ReadGpuMetrics(HardwareSnapshot hardware)
    {
        return new GpuMetrics
        {
            usage = PreferredValue(
                hardware.Sensors,
                SensorType.Load,
                new[] { "GPU Core", "GPU" },
                delegate(SensorSnapshot sensor) { return ContainsAny(sensor.Name, "gpu core"); }
            ),
            temp = PreferredValue(
                hardware.Sensors,
                SensorType.Temperature,
                new[] { "GPU Core", "Hot Spot", "Edge" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu core", "hot spot", "edge");
                }
            ),
            vram_usage = PreferredValue(
                hardware.Sensors,
                SensorType.Load,
                new[] { "GPU Memory" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu memory", "vram", "memory controller");
                }
            ),
            vram_temp = PreferredValue(
                hardware.Sensors,
                SensorType.Temperature,
                new[] { "GPU Memory Junction" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "memory junction", "gpu memory", "vram");
                }
            ),
            vram_used_mb = PreferredValue(
                hardware.Sensors,
                SensorType.SmallData,
                new[] { "GPU Memory Used" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu memory used", "vram used");
                }
            ) ?? PreferredValue(
                hardware.Sensors,
                SensorType.Data,
                new[] { "GPU Memory Used" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu memory used", "vram used");
                }
            ),
            vram_total_mb = PreferredValue(
                hardware.Sensors,
                SensorType.SmallData,
                new[] { "GPU Memory Total" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu memory total", "vram total");
                }
            ) ?? PreferredValue(
                hardware.Sensors,
                SensorType.Data,
                new[] { "GPU Memory Total" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu memory total", "vram total");
                }
            ),
        };
    }

    private static float? ReadBoardTemperature(List<SensorSnapshot> sensors)
    {
        return PreferredValue(
            sensors,
            SensorType.Temperature,
            new[] { "Temperature #1", "Motherboard", "System", "Board" },
            delegate(SensorSnapshot sensor)
            {
                return ContainsAny(sensor.Name, "motherboard", "system", "board");
            }
        );
    }

    private static float? ReadStorageTemperature(List<HardwareSnapshot> hardware)
    {
        foreach (var drive in hardware)
        {
            var temperature = PreferredValue(
                drive.Sensors,
                SensorType.Temperature,
                new[] { "Composite Temperature", "Composite", "Temperature #1", "Temperature" },
                null
            );
            if (temperature.HasValue)
            {
                return temperature;
            }
        }

        return null;
    }

    private static List<FanReading> ReadFans(List<HardwareSnapshot> hardware)
    {
        return hardware
            .Where(item => IsBoardHardwareType(item.Type) || IsGpuHardwareType(item.Type))
            .SelectMany(
                item => item.Sensors
                    .Where(sensor => sensor.Type == SensorType.Fan && sensor.Value.HasValue && sensor.Value > 0)
                    .Select(
                        sensor => new FanReading
                        {
                            name = FormatFanName(item.Type, sensor.Name),
                            rpm = (int)Math.Round(sensor.Value.Value, MidpointRounding.AwayFromZero),
                        }
                    )
            )
            .OrderBy(fan => fan.name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static HardwareSnapshot SelectPrimaryGpu(List<HardwareSnapshot> hardware)
    {
        HardwareSnapshot bestMatch = null;
        var bestMemory = -1f;
        var bestPriority = -1;

        foreach (var item in hardware.Where(item => IsGpuHardwareType(item.Type)))
        {
            var totalMemory = PreferredValue(
                item.Sensors,
                SensorType.SmallData,
                new[] { "GPU Memory Total", "D3D Dedicated Memory Total" },
                delegate(SensorSnapshot sensor)
                {
                    return ContainsAny(sensor.Name, "gpu memory total", "dedicated memory total");
                }
            ) ?? 0;
            var priority = GetGpuPriority(item.Type);

            if (totalMemory > bestMemory || (Math.Abs(totalMemory - bestMemory) < 0.001f && priority > bestPriority))
            {
                bestMatch = item;
                bestMemory = totalMemory;
                bestPriority = priority;
            }
        }

        return bestMatch;
    }

    private static int GetGpuPriority(HardwareType hardwareType)
    {
        if (hardwareType == HardwareType.GpuNvidia)
        {
            return 3;
        }

        if (hardwareType == HardwareType.GpuAmd)
        {
            return 2;
        }

        if (hardwareType == HardwareType.GpuIntel)
        {
            return 1;
        }

        return 0;
    }

    private static float? PreferredValue(
        List<SensorSnapshot> sensors,
        SensorType sensorType,
        IEnumerable<string> exactNames,
        Func<SensorSnapshot, bool> fallbackPredicate
    )
    {
        foreach (var exactName in exactNames)
        {
            var exactMatch = sensors.FirstOrDefault(
                sensor => sensor.Type == sensorType
                    && sensor.Value.HasValue
                    && string.Equals(sensor.Name, exactName, StringComparison.OrdinalIgnoreCase)
            );
            if (exactMatch != null && exactMatch.Value.HasValue)
            {
                return Round(exactMatch.Value.Value);
            }
        }

        if (fallbackPredicate == null)
        {
            return null;
        }

        var fallbackMatch = sensors.FirstOrDefault(
            sensor => sensor.Type == sensorType && sensor.Value.HasValue && fallbackPredicate(sensor)
        );
        return fallbackMatch != null && fallbackMatch.Value.HasValue
            ? Round(fallbackMatch.Value.Value)
            : (float?)null;
    }

    private static bool IsBoardHardwareType(HardwareType hardwareType)
    {
        return hardwareType == HardwareType.Motherboard || hardwareType == HardwareType.SuperIO;
    }

    private static bool IsGpuHardwareType(HardwareType hardwareType)
    {
        return hardwareType == HardwareType.GpuNvidia
            || hardwareType == HardwareType.GpuAmd
            || hardwareType == HardwareType.GpuIntel;
    }

    private static bool ContainsAny(string value, params string[] terms)
    {
        return terms.Any(
            term => value.IndexOf(term, StringComparison.OrdinalIgnoreCase) >= 0
        );
    }

    private static string FormatFanName(HardwareType hardwareType, string sensorName)
    {
        var normalized = CollapseWhitespace(sensorName.Replace("#", " "));
        if (IsGpuHardwareType(hardwareType) && !normalized.StartsWith("GPU", StringComparison.OrdinalIgnoreCase))
        {
            return "GPU " + normalized;
        }

        return normalized;
    }

    private static string CleanText(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        return CollapseWhitespace(
            new string(value.Where(character => !char.IsControl(character)).ToArray())
        );
    }

    private static string CollapseWhitespace(string value)
    {
        return Regex.Replace(value, "\\s+", " ").Trim();
    }

    private static float Round(float value)
    {
        return (float)Math.Round(value, 1, MidpointRounding.AwayFromZero);
    }
}

internal static class ServiceMetadata
{
    public const string SourceName = "Monitor Sensor Reader";
}

internal sealed class SensorMetricsPayload
{
    public CpuMetrics cpu = new CpuMetrics();
    public GpuMetrics gpu = new GpuMetrics();
    public TemperatureMetrics motherboard = new TemperatureMetrics();
    public TemperatureMetrics storage = new TemperatureMetrics();
    public List<FanReading> fans = new List<FanReading>();
    public string source = ServiceMetadata.SourceName;
    public string sampled_at = DateTimeOffset.UtcNow.ToString("O");
}

internal sealed class CpuMetrics
{
    public float? usage;
    public float? temp;
    public float? clock_mhz;
    public float? power_w;
}

internal sealed class GpuMetrics
{
    public float? usage;
    public float? temp;
    public float? vram_usage;
    public float? vram_temp;
    public float? vram_used_mb;
    public float? vram_total_mb;
}

internal sealed class TemperatureMetrics
{
    public float? temp;
}

internal sealed class FanReading
{
    public string name;
    public int rpm;
}

internal sealed class HealthPayload
{
    public bool ok = true;
    public string source = ServiceMetadata.SourceName;
}

internal sealed class ErrorPayload
{
    public ErrorPayload(string message)
    {
        error = message;
    }

    public string error;
    public string source = ServiceMetadata.SourceName;
}

internal sealed class HardwareSnapshot
{
    public HardwareType Type;
    public string Name;
    public List<string> Path;
    public List<SensorSnapshot> Sensors;
}

internal sealed class SensorSnapshot
{
    public SensorType Type;
    public string Name;
    public float? Value;
    public List<string> Path;
}
