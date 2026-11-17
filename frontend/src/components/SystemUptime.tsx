import React, { useEffect, useState } from 'react';

interface SystemUptimeProps {
  initialUptime: number | null;
}

/**
 * Isolated 1-second uptime ticker so the root App component does not re-render every second.
 */
const SystemUptime: React.FC<SystemUptimeProps> = React.memo(({ initialUptime }) => {
  const [uptime, setUptime] = useState<number | null>(initialUptime);

  useEffect(() => {
    if (initialUptime != null) {
      setUptime(initialUptime);
    }
  }, [initialUptime]);

  useEffect(() => {
    if (uptime == null) return;
    const timer = setInterval(() => {
      setUptime((prev) => (prev != null ? prev + 1 : prev));
    }, 1000);
    return () => clearInterval(timer);
  }, [uptime == null]);

  return (
    <span>
      連續運行時間:{' '}
      {uptime != null
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`
        : '--'}
    </span>
  );
});

export default SystemUptime;

