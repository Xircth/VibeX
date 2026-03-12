import { useParams, useNavigate } from 'react-router-dom';
import { WelcomePage } from '@/components/welcome/WelcomePage';
import { ProjectDetail } from '@/components/projects/ProjectDetail';

export function Projects() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const handleBack = () => {
    navigate('/local-projects');
  };

  if (projectId) {
    return <ProjectDetail projectId={projectId} onBack={handleBack} />;
  }

  return <WelcomePage />;
}
