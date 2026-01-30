import React, { useState, useEffect } from 'react';

interface Record {
  id: string;
  roomId: string;
  user_id: string;
  userId: string;
  type: string;
  filename: string;
  fileUrl: string;
  thumbnailUrl: string;
  startedAt: string;
  completedAt: string;
}

interface MeetingListProps {
  userId: string;
  serverUrl?: string;
}

const MeetingList: React.FC<MeetingListProps> = ({ 
  userId, 
  serverUrl = 'http://localhost:4000' 
}) => {
  const [records, setRecords] = useState<Record[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRecords();
  }, [userId]);

  const fetchRecords = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`${serverUrl}/api/v1/records/${userId}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch records: ${response.statusText}`);
      }
      
      const data = await response.json();
      setRecords(data.records || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      console.error('Error fetching records:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  if (loading) {
    return (
      <div className="meeting-list-container">
        <div className="loading">Loading records...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="meeting-list-container">
        <div className="error">Error: {error}</div>
        <button onClick={fetchRecords}>Retry</button>
      </div>
    );
  }

  return (
    <div className="meeting-list-container">
      <div className="header">
        <h2>Meeting Records</h2>
        <button onClick={fetchRecords}>Refresh</button>
      </div>
      
      {records.length === 0 ? (
        <div className="no-records">No recordings found for this user.</div>
      ) : (
        <div className="records-grid">
          {records.map((record) => (
            <div key={record.id} className="record-card">
              <div className="record-thumbnail">
                {record.thumbnailUrl ? (
                  <img 
                    src={`${serverUrl}${record.thumbnailUrl}`} 
                    alt={`Thumbnail for ${record.filename}`}
                  />
                ) : (
                  <div className="no-thumbnail">No thumbnail</div>
                )}
              </div>
              
              <div className="record-info">
                <h3>{record.filename}</h3>
                <div className="record-details">
                  <p><strong>Room ID:</strong> {record.roomId}</p>
                  <p><strong>Type:</strong> {record.type}</p>
                  <p><strong>Started:</strong> {formatDate(record.startedAt)}</p>
                  {record.completedAt && (
                    <p><strong>Completed:</strong> {formatDate(record.completedAt)}</p>
                  )}
                </div>
                
                {record.fileUrl && (
                  <div className="record-actions">
                    <a 
                      href={`${serverUrl}${record.fileUrl}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="btn-download"
                    >
                      Download Recording
                    </a>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      
      <div className="footer">
        <p>Total records: {records.length}</p>
      </div>
    </div>
  );
};

export default MeetingList;
